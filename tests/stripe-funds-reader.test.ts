// Step 4.6, S6, P3a.1 - lib/stripe-funds-reader.ts: the READER of the Stripe evidence of ONE payment's funds. Proved OFFLINE: no network, no Stripe key, no Stripe call - not even in Test Mode.
//
// What these tests are, and are not.
//   * They prove the READER: that it asks Stripe only for what the funds model (P1) reads, with the filters and the options in TWO arguments; that it walks every list to its end or says
//     it did not; that a movement it could not read makes the reading incomplete; that it checks the identity, the type and the MODE of what it was given; that it never invents,
//     repairs or drops a value; that it keeps personal data and secrets out of its output; and that when anything is missing or has been seen to change it degrades BOTH lists, so
//     that the funds model answers "uncertain" even for a caller who ignores the report.
//   * The Stripe of these tests is a FAKE (tests/_fake-stripe-funds.ts), written here: every object is BUILT, shaped after the SDK's types and after what the owner's Test Mode runs
//     OBSERVED (docs/VERIFICA-4.6.md S6a.17-S6a.19). Nothing here was fetched from Stripe. What Stripe really does with `disputes.list`, with a refund that waits for an action, with
//     a restricted key, or while objects change under a read, is NOT proved here (docs/VERIFICA-4.6.md S6a.22, "simulated fixtures versus real observations").
//   * A reading is a COMPOSITION of observations made at different moments, not a snapshot. Nothing below claims that two identical reads of the payment prove that the other objects did
//     not change: the tests PIN what the closing read sees (H), what it cannot see (H13: the matrix of events and moments, with the known limits as an ALLOWED set - never a quota to
//     keep), and what the report says nobody verified (`FUNDS_READ_NOT_VERIFIED`).
//   * The refunds the APPLICATION asked for (`requestedRefunds`) are not Stripe's: the reader COPIES them - once, before its first await, id/amount/currency only, nothing repaired, nothing
//     de-duplicated, at most a thousand - or refuses them as a whole (section R). It never hands the caller's own array or objects over.
//   * The position of the money is computed ONLY by P1 (`computeFundsPosition`), here, in the tests. The reader holds no arithmetic, no threshold and takes no decision.
//   * Written BEFORE the module existed (red), green after. The module is loaded lazily on purpose, so that each test fails on its own when it is missing.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import Stripe from 'stripe'
import type { FundsEvidence, FundsPosition } from '../lib/payment-hold-evidence'
import type {
  FundsEvidenceOut, FundsReadOptions, FundsReadRequest, ReadCall, ReadFailureKind, ReadRequestOptions, RequestedRefundInput, StripeFundsClient, StripeFundsRead,
} from '../lib/stripe-funds-reader'
import { stripComments } from './_source-scan'
import {
  ANCHORS, CANARIES, CANARY_VALUES, EXPECTED_FIELDS, FAKE_KEY, METHODS, PAIRS, World, applyEvent, between, caseWorld, clone, expectedProjection,
  fail, mulberry32, ok, pick, randomWorld, scheduleRandomEvents, sdkErrors, wire, type CallInfo, type EventId,
  type Method, type Outcome, type Random, type Rec,
} from './_fake-stripe-funds'

type Mod = typeof import('../lib/stripe-funds-reader')
let loaded: Promise<Mod> | null = null
const load = (): Promise<Mod> => (loaded ??= import('../lib/stripe-funds-reader'))
type P1Mod = typeof import('../lib/payment-hold-evidence')
let loadedP1: Promise<P1Mod> | null = null
const loadP1 = (): Promise<P1Mod> => (loadedP1 ??= import('../lib/payment-hold-evidence'))
const position = async (evidence: unknown): Promise<FundsPosition> => (await loadP1()).computeFundsPosition(evidence as FundsEvidence)

// ---- every network attempt of this file is refused and recorded (section L proves there was none; the control proves the refusal works) -------------------------------------------------
const NETWORK_ATTEMPTS: string[] = []
function refusalOf(into: string[]) {
  const refuse = (name: string) => (...args: unknown[]) => { into.push(`${name} ${String(args[0]).slice(0, 60)}`); throw new Error(`network blocked: ${name}`) }
  return { http: { request: refuse('http.request'), get: refuse('http.get') }, https: { request: refuse('https.request'), get: refuse('https.get') }, net: { connect: refuse('net.connect'), createConnection: refuse('net.createConnection') }, fetch: refuse('fetch') }
}
function installNetworkRefusal(into: string[]): () => void {
  const originals = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get, connect: net.connect, createConnection: net.createConnection, fetch: globalThis.fetch }
  const refusal = refusalOf(into)
  ;(http as any).request = refusal.http.request; (http as any).get = refusal.http.get; (https as any).request = refusal.https.request; (https as any).get = refusal.https.get
  ;(net as any).connect = refusal.net.connect; (net as any).createConnection = refusal.net.createConnection; (globalThis as any).fetch = refusal.fetch
  return () => {
    ;(http as any).request = originals.httpRequest; (http as any).get = originals.httpGet; (https as any).request = originals.httpsRequest; (https as any).get = originals.httpsGet
    ;(net as any).connect = originals.connect; (net as any).createConnection = originals.createConnection; (globalThis as any).fetch = originals.fetch
  }
}
const restoreNetwork = installNetworkRefusal(NETWORK_ATTEMPTS)

// ---- helpers -------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Extras = { request?: Record<string, unknown>; options?: Record<string, unknown>; client?: unknown }
async function read(world: World, extras: Extras = {}): Promise<StripeFundsRead> {
  const { readStripeFundsEvidence } = await load()
  return readStripeFundsEvidence(
    (extras.client ?? world.client()) as StripeFundsClient,
    { paymentIntentId: world.piId, expectedLivemode: world.livemode, ...extras.request } as FundsReadRequest,
    { now: world.clock.now, ...extras.options } as FundsReadOptions,
  )
}
const W = (over: ConstructorParameters<typeof World>[0] = {}) => new World({ pi: 'pi_t1', charge: 'ch_t1', ...over })
const ids = (list: any): string[] => (list?.data ?? []).map((entry: any) => entry.id)
const reasonsOf = (result: StripeFundsRead) => [...result.reading.structure.incomplete].sort()
const methodsOf = (world: World) => world.calls.map((call) => call.method)
const isClean = (result: StripeFundsRead) => result.reading.structure.complete && result.reading.temporal.observation === 'no_change_observed'
const DEFAULT_SEQUENCE: Method[] = ['paymentIntents.retrieve', 'refunds.list', 'disputes.list', 'paymentIntents.retrieve']
function assertFailClosed(result: StripeFundsRead, label: string) {
  if (isClean(result)) return
  for (const key of ['refunds', 'disputes'] as const) {
    const list = result.evidence[key]
    if (list !== null) assert.equal((list as any).has_more, true, `${label}: ${key} must be degraded (has_more: true) when the reading is not clean`)
  }
}
function assertNoCanary(value: unknown, label: string) {
  const text = JSON.stringify(value)
  for (const canary of CANARY_VALUES) assert.ok(!text.includes(canary), `${label}: "${canary}" reached the output`)
}
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) allKeys(entry, into)
  else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { into.add(key); allKeys(inner, into) }
  return into
}
function expectedFromOracle(raw: Rec): Rec {
  return {
    paymentIntent: expectedProjection('paymentIntent', raw.paymentIntent),
    charge: raw.charge === null ? null : expectedProjection('charge', raw.charge),
    refunds: { data: raw.refunds.data.map((entry: Rec) => expectedProjection('refund', entry)), has_more: false },
    disputes: { data: raw.disputes.data.map((entry: Rec) => expectedProjection('dispute', entry)), has_more: false },
  }
}
const WORLDS = Math.max(50, Number(process.env.FUNDS_READER_WORLDS ?? 800) || 800)   // property tests: a fixed seed range, scalable from outside for the large runs
const codes = (p: FundsPosition) => p.findings.map((entry) => `${entry.kind}:${entry.code}`).sort()

// =====================================================================================================================================================================
// Z0. The fake is faithful to the Stripe behaviours it stands for (independent of the reader: if these fail, no other result can be trusted)
// =====================================================================================================================================================================
test('Z0 the fake lists newest first, with limit and has_more, and a cursor is a position', async () => {
  const world = W()
  for (let index = 1; index <= 5; index++) world.addRefund({ id: `re_${index}`, amount: index, status: 'pending' })
  const client = world.client()
  const first: any = await client.refunds.list({ payment_intent: 't', limit: 2 } as any)
  assert.equal(first.object, 'list')
  const none: any = await client.refunds.list({ payment_intent: world.piId, limit: 2 })
  assert.deepEqual(none.data.map((entry: Rec) => entry.id), ['re_5', 're_4'])
  assert.equal(none.has_more, true)
  const next: any = await client.refunds.list({ payment_intent: world.piId, limit: 2, starting_after: 're_4' })
  assert.deepEqual(next.data.map((entry: Rec) => entry.id), ['re_3', 're_2'])
  assert.equal(next.has_more, true)
  const last: any = await client.refunds.list({ payment_intent: world.piId, limit: 2, starting_after: 're_2' })
  assert.deepEqual(last.data.map((entry: Rec) => entry.id), ['re_1'])
  assert.equal(last.has_more, false)
  const defaultLimit: any = await client.refunds.list({ payment_intent: world.piId } as any)
  assert.equal(defaultLimit.data.length, 5, 'the default limit is 10')
  await assert.rejects(client.refunds.list({ payment_intent: world.piId, limit: 2, starting_after: 're_unknown' }), (error: any) => error.type === 'StripeInvalidRequestError' && error.statusCode === 404 && error.code === 'resource_missing')
})

test('Z0 an object born after the cursor sits BEFORE it: later pages never show it', async () => {
  const world = W()
  for (let index = 1; index <= 4; index++) world.addRefund({ id: `re_${index}`, amount: index, status: 'pending' })
  const client = world.client()
  const page1: any = await client.refunds.list({ payment_intent: world.piId, limit: 2 })
  world.addRefund({ id: 're_late', amount: 9, status: 'pending' })
  const page2: any = await client.refunds.list({ payment_intent: world.piId, limit: 2, starting_after: page1.data[1].id })
  const seen = [...page1.data, ...page2.data].map((entry: Rec) => entry.id)
  assert.ok(!seen.includes('re_late'), 'the late refund is invisible to the walk')
  assert.equal(seen.length, new Set(seen).size, 'and nothing is repeated or skipped')
})

test('Z0 the SDK trap: filters and options in ONE object lose every filter (an unfiltered list of the whole account, default limit)', async () => {
  const world = W()
  world.addRefund({ id: 're_own', amount: 5, status: 'pending' })
  for (let index = 1; index <= 3; index++) world.addForeignRefund({ id: `re_foreign_${index}` })
  const client = world.client()
  const wrong: any = await client.refunds.list({ payment_intent: world.piId, limit: 100, timeout: 5000 } as any)
  assert.ok(wrong.data.some((entry: Rec) => entry.id.startsWith('re_foreign_')), 'foreign refunds appear: the request went out unfiltered')
  const right: any = await client.refunds.list({ payment_intent: world.piId, limit: 100 }, { timeout: 5000 })
  assert.deepEqual(right.data.map((entry: Rec) => entry.id), ['re_own'])
})

test('Z0 amount_refunded follows the refunds (a pending one is inside, a failed one is not; requires_action is a switch) and the dispute flag is sticky', async () => {
  const world = W()
  world.addRefund({ id: 're_s', amount: 10, status: 'succeeded' })
  world.addRefund({ id: 're_p', amount: 5, status: 'pending' })
  world.addRefund({ id: 're_f', amount: 7, status: 'failed' })
  world.addRefund({ id: 're_r', amount: 3, status: 'requires_action' })
  assert.equal(world.chargeObject()?.amount_refunded, 15)
  world.countsRequiresAction = true
  assert.equal(world.chargeObject()?.amount_refunded, 18)
  assert.equal(world.chargeObject()?.disputed, false)
  world.addDispute({ id: 'dp_1', status: 'needs_response' })
  world.winDispute('dp_1')
  assert.equal(world.chargeObject()?.disputed, true, 'the flag stays true after a win')
})

test('Z0 balance transactions are immutable, resolvable by id only, and a dispute carries its own inline', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  world.addDispute({ id: 'dp_1', amount: 100, status: 'won' })
  const client = world.client()
  const bt: any = await client.balanceTransactions.retrieve('txn_re_a', {})
  assert.deepEqual([bt.id, bt.object, bt.amount, bt.fee, bt.net, bt.reporting_category, bt.source], ['txn_re_a', 'balance_transaction', -20, 0, -20, 'refund', 're_a'])
  await assert.rejects(client.balanceTransactions.retrieve('txn_nope', {}), (error: any) => error.statusCode === 404)
  const list: any = await client.refunds.list({ payment_intent: world.piId, limit: 5 })
  assert.equal(typeof list.data[0].balance_transaction, 'string', 'a refund names its balance transaction by id')
  const disputes: any = await client.disputes.list({ payment_intent: world.piId, limit: 5 })
  assert.ok(disputes.data[0].balance_transactions.every((entry: unknown) => typeof entry === 'object'), 'a dispute carries its balance transactions as objects')
  assert.deepEqual(disputes.data[0].balance_transactions.map((entry: Rec) => entry.reporting_category), ['dispute', 'dispute_reversal'])
})

test('Z0 a client that honors the timeout fails with the SDK timeout error; a detached method fails; unknown parameters and bad limits are refused; responses are read-only', async () => {
  const world = W({ latencyMs: 9000 })
  const client = world.client()
  const before = world.clock.now()
  await assert.rejects(client.paymentIntents.retrieve(world.piId, { expand: ['latest_charge'] }, { timeout: 2000 }), (error: any) => error.type === 'StripeConnectionError' && error.detail?.code === 'ETIMEDOUT')
  assert.equal(world.clock.now() - before, 2000, 'the clock advanced by the timeout, not by the latency')
  const fast = W()
  const detached = fast.client().refunds.list
  assert.throws(() => detached({ payment_intent: fast.piId, limit: 1 }), TypeError)
  await assert.rejects(fast.client().refunds.list({ payment_intent: fast.piId, limit: 0 }), (error: any) => error.statusCode === 400)
  await assert.rejects(fast.client().refunds.list({ payment_intent: fast.piId, limit: 101 }), (error: any) => error.statusCode === 400)
  await assert.rejects(fast.client().refunds.list({ payment_intent: fast.piId, limit: 5, bogus: 1 } as any), (error: any) => error.statusCode === 400)
  const pi: any = await fast.client().paymentIntents.retrieve(fast.piId, { expand: ['latest_charge'] })
  assert.throws(() => { pi.status = 'canceled' }, TypeError)
  assert.throws(() => { pi.latest_charge.amount_refunded = 99 }, TypeError)
  assert.deepEqual(fast.mutationAttempts.length, 2)
  assert.equal(typeof pi.latest_charge, 'object', 'expand returns the charge object')
  const plain: any = await fast.client().paymentIntents.retrieve(fast.piId, { expand: [] })
  assert.equal(plain.latest_charge, 'ch_t1', 'without expand it stays an id')
})

test('Z0 events fire before the nth call of a method, in order, once; the log keeps parameters and options as received', async () => {
  const world = W()
  world.at('T1', (w) => w.addRefund({ id: 're_ev', amount: 3, status: 'pending' }), 'a refund appears')
  const client = world.client()
  const a: any = await client.paymentIntents.retrieve(world.piId, { expand: ['latest_charge'] }, { timeout: 111, maxNetworkRetries: 0 })
  assert.equal(a.latest_charge.amount_refunded, 0)
  const listed: any = await client.refunds.list({ payment_intent: world.piId, limit: 10 }, { timeout: 222 })
  assert.deepEqual(ids(listed), ['re_ev'])
  assert.deepEqual(world.unfired(), [])
  assert.deepEqual(world.calls.map((call) => [call.method, call.nth, call.options]), [['paymentIntents.retrieve', 1, { timeout: 111, maxNetworkRetries: 0 }], ['refunds.list', 1, { timeout: 222 }]])
  assert.deepEqual(ANCHORS.T3, { method: 'paymentIntents.retrieve', nth: 2 })
})

// =====================================================================================================================================================================
// A. The contract and the read-only guards
// =====================================================================================================================================================================
const ROOT = process.cwd()
const MODULE_FILE = 'lib/stripe-funds-reader.ts'
const readSource = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const moduleCode = () => stripComments(readSource(MODULE_FILE))

const FORBIDDEN_IN_THE_READER: Array<[string, RegExp]> = [
  ['an import, a re-export or a require (the reader needs nothing: not even a type)', /(^|\n)\s*import[\s({]|\bimport\s*\(|\brequire\s*\(|\bexport\s+\*\s+from\b|\bexport\s+(type\s+)?\{[^}]*\}\s+from\b/],
  ['the clock (the clock is INJECTED)', /\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/],
  ['randomness', /\bMath\.random\b|\bcrypto\b|\brandomUUID\b|\brandomBytes\b/],
  ['the environment', /\bprocess\b|\bglobalThis\b|\bwindow\b|\bdocument\b|\bimport\.meta\b|\bBuffer\b/],
  ['the network or the disk', /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bhttps?:\/\/|\bfs\./],
  ['output', /\bconsole\b|\bdebugger\b/],
  ['dynamic code', /\beval\s*\(|\bnew\s+Function\b/],
  ['a race, a timer or a combinator of promises (no deadline is enforced by a timer: see section G)', /\bPromise\s*\.\s*(race|all|any|allSettled)\b|\.then\s*\(|\.catch\s*\(/],
  ['floating point or rounding for money', /\btoFixed\b|\bparseFloat\b|\bparseInt\b|\bNumber\.parse|\bMath\.(round|ceil|trunc|fround)\b/],
  ['state kept between calls (a mutable binding at module level)', /^(let|var)\s/m],
]
test('A1 the reader is PURE of the world: no import, no clock, no randomness, no environment, no network, no disk, no output, no timer or race, no rounding, no state between calls', () => {
  const code = moduleCode()
  for (const [what, pattern] of FORBIDDEN_IN_THE_READER) assert.ok(!pattern.test(code), `the reader uses ${what}: ${String(pattern)}`)
})

test('A2 the reader never writes: no method of Stripe that creates, updates, deletes, cancels, expires, captures or confirms; no idempotency key', () => {
  const code = moduleCode()
  assert.ok(!/\.\s*(create|update|del|delete|cancel|expire|capture|confirm|post|put|patch|submit|upsert|retry)\s*\(/.test(code), 'a write-like call')
  assert.ok(!/idempotenc/i.test(code), 'an idempotency key')
})

test('A3 the only calls the reader makes on the client are the four of the interface (the set of call sites is exactly these), always as methods, never computed', () => {
  const code = moduleCode()
  const sites = new Set([...code.matchAll(/\bclient\s*\.\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g)].map((match) => `${match[1]}.${match[2]}`))
  assert.deepEqual([...sites].sort(), ['balanceTransactions.retrieve', 'disputes.list', 'paymentIntents.retrieve', 'refunds.list'])
  assert.ok(!/\bclient\s*\[/.test(code), 'a computed access on the client')
  assert.ok(!/\bclient\s*\.\s*[A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*\s*\.\s*(call|apply|bind)\b/.test(code), 'a method used detached')
})

test('A4 the reader does not name the funds model or itself, nothing of the application names the reader, and no operational module knows it', () => {
  assert.ok(!readSource(MODULE_FILE).includes('payment-hold-evidence'), 'the guard of the funds model forbids the name anywhere in lib/, even in a comment')
  const code = moduleCode()
  assert.ok(!/stripe-funds-reader|readStripeFundsEvidence\s*\(\s*getStripe|getStripe/.test(code))
  const sourceFiles = (dir: string, into: string[] = []): string[] => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) { if (!['node_modules', '.next', '.git'].includes(entry.name)) sourceFiles(full, into) } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) into.push(full)
    }
    return into
  }
  const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map((entry) => entry.name)
  const files = [...rootFiles, ...['app', 'lib', 'components', 'scripts', 'prisma'].filter((dir) => fs.existsSync(path.join(ROOT, dir))).flatMap((dir) => sourceFiles(dir))]
  const ALLOWED_IMPORTERS: string[] = []   // the reader is verified IN ISOLATION first: a package that is authorized to wire it changes this list on purpose
  assert.deepEqual(files.filter((file) => file !== MODULE_FILE && /stripe-funds-reader|readStripeFundsEvidence/.test(readSource(file))), ALLOWED_IMPORTERS)
  for (const file of ['lib/payment-hold.ts', 'lib/payment-sync.ts', 'lib/order-payment-policy.ts', 'lib/production-release.ts', 'lib/payment-verification.ts', 'lib/stripe-webhook.ts', 'lib/stripe-payments.ts', 'lib/financial-revision.ts']) {
    assert.ok(!/stripe-funds-reader|readStripeFundsEvidence/.test(readSource(file)), `${file} must not know the reader yet`)
  }
})

test('A5 the public surface is small and fixed: one function and four frozen constants', async () => {
  const mod = await load()
  assert.deepEqual(Object.keys(mod).sort(), ['FUNDS_READ_DEFAULTS', 'FUNDS_READ_NOT_VERIFIED', 'FUNDS_READ_STRUCTURE_REASONS', 'FUNDS_READ_TEMPORAL_SIGNALS', 'readStripeFundsEvidence'])
  assert.equal(typeof mod.readStripeFundsEvidence, 'function')
  for (const constant of [mod.FUNDS_READ_DEFAULTS, mod.FUNDS_READ_NOT_VERIFIED, mod.FUNDS_READ_STRUCTURE_REASONS, mod.FUNDS_READ_TEMPORAL_SIGNALS]) assert.ok(Object.isFrozen(constant))
  assert.deepEqual(mod.FUNDS_READ_DEFAULTS, { perCallTimeoutMs: 5000, deadlineMs: 15000, pageSize: 100, maxPages: 5, maxMovementReads: 20 })
  assert.deepEqual([...mod.FUNDS_READ_STRUCTURE_REASONS], [
    'invalid_input', 'payment_intent_not_read', 'payment_intent_identity', 'mode_unverified', 'mode_mismatch', 'mode_mixed', 'charge_unexpanded', 'charge_identity', 'payment_flow_not_modeled',
    'refunds_not_read', 'refunds_truncated', 'disputes_not_read', 'disputes_truncated', 'movements_unresolved', 'budget_exhausted', 'reader_error',
  ])
  assert.deepEqual([...mod.FUNDS_READ_TEMPORAL_SIGNALS], ['payment_intent_changed', 'payment_intent_unverified', 'pagination_anomaly'])
})

// ---- checked by tsc only (npm run typecheck): the real client IS the interface, the interface has no write method, and the output IS evidence ------------------------------------------
function theRealClientIsTheInterface(real: Stripe): StripeFundsClient { return real }
function noWriteMethodIsOnTheInterface(client: StripeFundsClient) {
  // @ts-expect-error the interface has no refunds.create
  client.refunds.create
  // @ts-expect-error the interface has no paymentIntents.cancel
  client.paymentIntents.cancel
  // @ts-expect-error the interface has no disputes.update
  client.disputes.update
  // @ts-expect-error the interface has no balanceTransactions.list
  client.balanceTransactions.list
  // @ts-expect-error the interface has no checkout
  client.checkout
}
// @ts-expect-error a client without refunds.list is not a client of the interface
const incompleteClient: StripeFundsClient = { paymentIntents: { retrieve: async () => ({}) }, disputes: { list: async () => ({}) }, balanceTransactions: { retrieve: async () => ({}) } }
function theOutputIsEvidence(result: StripeFundsRead): FundsEvidence { return result.evidence }
// D5, also checked by tsc only: the requests are an OPTIONAL part of the output and, when present, an array of the three fields (never null: an absent key is how "none" is said); a refusal can be reported
// with the types of the report (`input`, `invalid_input`); and an output with no requests, or with a copy of them, is still the funds model's evidence
const requestedRefundsIsOptional: {} extends Pick<FundsEvidenceOut, 'requestedRefunds'> ? true : false = true
const evidenceWithoutRequests: FundsEvidenceOut = { paymentIntent: null, charge: null, refunds: null, disputes: null }
const aRefusalIsReportableByTheTypes: [ReadCall, ReadFailureKind] = ['input', 'invalid_input']
function evidenceWithoutRequestsIsEvidence(out: FundsEvidenceOut): FundsEvidence { return out }
function aCopyOfTheRequestsIsEvidence(requests: RequestedRefundInput[], out: FundsEvidenceOut): FundsEvidence { return { ...out, requestedRefunds: requests } }
// @ts-expect-error the requests of the output are an array when they are there: not null
const nullRequests: FundsEvidenceOut = { paymentIntent: null, charge: null, refunds: null, disputes: null, requestedRefunds: null }
test('A6 the real Stripe client is structurally the interface and the output is the funds model\'s evidence (the proof is the compilation of this file)', () => {
  assert.equal(typeof theRealClientIsTheInterface, 'function')
  assert.equal(typeof noWriteMethodIsOnTheInterface, 'function')
  assert.equal(typeof theOutputIsEvidence, 'function')
  assert.equal(typeof incompleteClient, 'object')
  assert.equal(requestedRefundsIsOptional, true)
  assert.deepEqual(aRefusalIsReportableByTheTypes, ['input', 'invalid_input'])
  assert.ok(!('requestedRefunds' in evidenceWithoutRequests))
  assert.equal(typeof evidenceWithoutRequestsIsEvidence, 'function')
  assert.equal(typeof aCopyOfTheRequestsIsEvidence, 'function')
  assert.equal(typeof nullRequests, 'object')
})

test('A7 a TRAP client sees only the four methods: every other access would throw, and a whole reading touches nothing else', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  world.addDispute({ id: 'dp_1', status: 'lost' })
  const { client, touched } = world.trapClient()
  const result = await read(world, { client })
  assert.equal(result.reading.structure.complete, true)
  assert.deepEqual([...new Set(touched)].sort(), ['balanceTransactions', 'balanceTransactions.retrieve', 'disputes', 'disputes.list', 'paymentIntents', 'paymentIntents.retrieve', 'refunds', 'refunds.list'])
  assert.throws(() => (client as any).refunds.create, /forbidden access/)
  assert.throws(() => (client as any).checkout, /forbidden access/)
})

test('A8 the methods are called AS methods (a client whose methods need their receiver works), parameters and options always in TWO arguments, nothing of the options inside the parameters', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  const result = await read(world)
  assert.equal(result.reading.structure.complete, true)
  for (const call of world.calls) {
    const keys = Object.keys(call.params ?? {})
    for (const forbidden of ['timeout', 'maxNetworkRetries', 'idempotencyKey', 'stripeAccount', 'apiKey', 'apiVersion', 'host']) assert.ok(!keys.includes(forbidden), `${call.method}: ${forbidden} is inside the parameters`)
    assert.deepEqual(Object.keys(call.options).sort(), ['maxNetworkRetries', 'timeout'], `${call.method}: the options are their own argument`)
    assert.equal(call.options.maxNetworkRetries, 0, `${call.method}: no retry of the reader's own`)
    assert.ok(Number.isInteger(call.options.timeout) && call.options.timeout > 0, `${call.method}: an explicit timeout, never omitted and never 0`)
    if (call.method === 'paymentIntents.retrieve') assert.deepEqual(call.params, { expand: ['latest_charge'] })
    else if (call.method === 'balanceTransactions.retrieve') assert.deepEqual(call.params, {})
    else {
      assert.ok(Object.keys(call.params).every((key) => ['payment_intent', 'limit', 'starting_after'].includes(key)), `${call.method}: only the filter, the limit and the cursor`)
      assert.equal(call.params.payment_intent, world.piId)
      assert.ok(Number.isInteger(call.params.limit) && call.params.limit >= 1 && call.params.limit <= 100)
      assert.ok(!('expand' in call.params), 'no expansion on a list')
    }
  }
  const first = world.callsOf('refunds.list')[0]
  assert.ok(!('starting_after' in first.params), 'the first page has no cursor (null would send an empty one)')
})

test('A9 the report has no field that sounds like a decision or a guarantee, anywhere, in any kind of reading; nothing exported does either', async () => {
  const FORBIDDEN = ['final', 'safe', 'ok', 'trusted', 'eligible', 'decision', 'snapshot', 'accepted', 'no_charge', 'release', 'authorized', 'approved', 'stable', 'consistent']
  const worlds: World[] = [W(), W(), W(), W()]
  worlds[1].addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  worlds[2].at('T3', (w) => w.addRefund({ id: 're_x', amount: 5, status: 'pending' }))
  worlds[3].piOverride = { livemode: 'false' }
  const seen = new Set<string>()
  for (const world of worlds) for (const key of allKeys(await read(world))) seen.add(key)
  for (const key of allKeys(await read(W(), { request: { paymentIntentId: 'cs_bad' } }))) seen.add(key)
  for (const word of FORBIDDEN) assert.ok(!seen.has(word), `a key of the report is called "${word}"`)
  for (const name of Object.keys(await load())) for (const word of FORBIDDEN) assert.ok(!name.toLowerCase().includes(word.replace('_', '')), `an export is called like "${word}"`)
})

test('A10 the reader holds no operational policy: no threshold of age, recency, agreement or repetition, no decision, in its code; the only numbers it exports are the budget defaults', async () => {
  const code = moduleCode()
  assert.ok(!/\b(maxAge|recency|recent|staleness|agree|agreement|repeat|retry|release|accepted|noCharge|no_charge|decision|decide|eligible|threshold)\b/i.test(code), 'a word of an operational policy')
  const mod: Rec = await load()
  const numeric = Object.entries(mod).filter(([, value]) => typeof value === 'number')
  assert.deepEqual(numeric, [])
  assert.deepEqual(Object.keys(mod.FUNDS_READ_DEFAULTS).sort(), ['deadlineMs', 'maxMovementReads', 'maxPages', 'pageSize', 'perCallTimeoutMs'])
})

// =====================================================================================================================================================================
// B. Ordinary cases (all of them through the funds model: the reader holds no arithmetic)
// =====================================================================================================================================================================
test('B1 a regular payment, nothing refunded, nothing disputed: four calls in this order, the exact evidence, the exact report, and the funds model proves the whole capital', async () => {
  const world = W()
  const start = world.clock.now()
  const result = await read(world)
  assert.deepEqual(methodsOf(world), DEFAULT_SEQUENCE)
  assert.deepEqual(result.evidence, {
    paymentIntent: { id: 'pi_t1', amount_received: 100, currency: 'eur', status: 'succeeded', latest_charge: { id: 'ch_t1' } },
    charge: { id: 'ch_t1', amount_captured: 100, amount_refunded: 0, currency: 'eur', disputed: false, payment_intent: 'pi_t1' },
    refunds: { data: [], has_more: false },
    disputes: { data: [], has_more: false },
  })
  assert.deepEqual(Object.keys(result.evidence).sort(), ['charge', 'disputes', 'paymentIntent', 'refunds'], 'no requestedRefunds key when none was given')
  const { reading } = result
  assert.deepEqual(reading.structure, { complete: true, parts: { paymentIntent: 'verified', charge: 'verified', refunds: 'complete', disputes: 'complete', movements: 'not_needed', mode: 'verified' }, incomplete: [] })
  const { notVerified, ...temporal } = reading.temporal
  assert.deepEqual(temporal, {
    observation: 'no_change_observed', paymentIntentRecheck: 'same', pagination: 'regular', signals: [], startedAtMs: start, finishedAtMs: start + 160, spanMs: 160, withinDeadline: true,
  })
  assert.ok(Array.isArray(notVerified) && notVerified.length === 9)
  assert.deepEqual(reading.mode, { expected: false, observed: 'test' })
  assert.deepEqual(reading.failures, [])
  assert.deepEqual(reading.counts, { calls: 4, refundPages: 1, disputePages: 1, movementReads: 0, unresolvedMovements: 0 })
  const p = await position(result.evidence)
  assert.equal(p.certainty, 'proven')
  assert.equal(p.final, true)
  assert.deepEqual([p.retainedLowerCents, p.retainedUpperCents], [100, 100])
  assert.deepEqual(p, await position(world.oracleRaw()))
})

test('B2 a partial refund that succeeded: its balance transaction is read by id (5 calls), the evidence is exactly the projection of what the world says, and the funds model proves 80', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  const result = await read(world)
  assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve', 'refunds.list', 'disputes.list', 'balanceTransactions.retrieve', 'paymentIntents.retrieve'])
  assert.deepEqual(world.callsOf('balanceTransactions.retrieve')[0].id, 'txn_re_a')
  assert.deepEqual(result.evidence, expectedFromOracle(world.oracleRaw()))
  assert.deepEqual(result.evidence.refunds?.data[0], {
    id: 're_a', amount: 20, currency: 'eur', status: 'succeeded', payment_intent: 'pi_t1', charge: 'ch_t1', balance_transaction: { id: 'txn_re_a', amount: -20, currency: 'eur', fee: 0, net: -20, reporting_category: 'refund', source: 're_a' },
    failure_balance_transaction: null,
  })
  assert.equal(result.reading.structure.parts.movements, 'resolved')
  assert.equal(result.reading.counts.movementReads, 1)
  const p = await position(result.evidence)
  assert.deepEqual([p.certainty, p.final, p.retainedLowerCents, p.retainedUpperCents], ['proven', false, 80, 80])
})

test('B3 a total refund that succeeded: zero, proven, but NOT final - "is nothing held?" stays unknown (the zero of a snapshot is not one to rely on)', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 100, status: 'succeeded' })
  const { retainedIsZero } = await loadP1()
  const p = await position((await read(world)).evidence)
  assert.deepEqual([p.certainty, p.final, p.retainedLowerCents, p.retainedUpperCents], ['proven', false, 0, 0])
  assert.equal(retainedIsZero(p), 'unknown')
})

test('B4 two refunds that succeeded and one that failed: the sums are exactly what the model says, the failure movement is read, nothing is added up by the reader', async () => {
  const world = W()
  world.addRefund({ id: 're_1', amount: 10, status: 'succeeded' })
  world.addRefund({ id: 're_2', amount: 15, status: 'succeeded' })
  world.addRefund({ id: 're_3', amount: 20, status: 'failed' })
  const result = await read(world)
  assert.equal(world.callsOf('balanceTransactions.retrieve').length, 4)
  assert.deepEqual(new Set(world.callsOf('balanceTransactions.retrieve').map((call) => call.id)), new Set(['txn_re_1', 'txn_re_2', 'txn_re_3', 'txn_f_re_3']))
  const p = await position(result.evidence)
  assert.deepEqual([p.certainty, p.refunds.confirmedCents, p.refunds.reversedCents, p.retainedLowerCents, p.retainedUpperCents], ['proven', 25, 20, 75, 75])
})

test('B5 a dispute that was lost, with its withdrawal and its fee: zero, proven, final; the fee is kept apart', async () => {
  const world = W()
  world.addDispute({ id: 'dp_1', amount: 100, status: 'lost', fee: 2000 })
  const { retainedIsZero } = await loadP1()
  const result = await read(world)
  assert.equal(world.callsOf('balanceTransactions.retrieve').length, 0, 'the movements of a dispute are inline: nothing to read')
  assert.deepEqual(result.evidence.disputes?.data[0], {
    id: 'dp_1', amount: 100, currency: 'eur', status: 'lost', payment_intent: 'pi_t1', charge: 'ch_t1',
    balance_transactions: [{ id: 'txn_dpw_dp_1', amount: -100, currency: 'eur', fee: 2000, net: -2100, reporting_category: 'dispute', source: 'dp_1' }],
  })
  const p = await position(result.evidence)
  assert.deepEqual([p.certainty, p.final, p.retainedLowerCents, p.retainedUpperCents, p.fees.disputeCents], ['proven', true, 0, 0, 2000])
  assert.equal(retainedIsZero(p), 'yes')
})

test('B6 a dispute that was won, with its withdrawal and its reinstatement: the whole capital, proven; the fee is not given back', async () => {
  const world = W()
  world.addDispute({ id: 'dp_1', amount: 100, status: 'won', fee: 2000 })
  const p = await position((await read(world)).evidence)
  assert.deepEqual([p.certainty, p.retainedLowerCents, p.retainedUpperCents, p.fees.disputeCents], ['proven', 100, 100, 2000])
})

test('B7 KNOWN LIMIT - a payment canceled WITHOUT a charge: the reader reports "none_reported" (what the payment says, not proof of no money), never builds a charge, the reading is structurally complete, and the funds model stays uncertain', async () => {
  const world = W({ status: 'canceled', charge: null })
  const result = await read(world)
  assert.equal(result.evidence.charge, null, 'a charge is never made up')
  assert.equal(result.evidence.paymentIntent?.latest_charge, null)
  assert.equal(result.reading.structure.parts.charge, 'none_reported')
  assert.equal(result.reading.structure.complete, true)
  assert.deepEqual(methodsOf(world), DEFAULT_SEQUENCE)
  const { retainedIsZero } = await loadP1()
  const p = await position(result.evidence)
  assert.equal(p.certainty, 'uncertain', 'the model asks for a charge object for its cross-checks (D-2): a future change of the model will change this on purpose')
  assert.notEqual(retainedIsZero(p), 'yes')
  assert.ok(codes(p).includes('uncertainty:refund_total_not_read'))
})

test('B8 a payment that is not paid yet (no charge): the funds model has no upper limit; the reader invents no amount', async () => {
  const world = W({ status: 'requires_payment_method', charge: null, amountReceived: 0 })
  const p = await position((await read(world)).evidence)
  assert.equal(p.retainedUpperCents, null)
  assert.equal(p.certainty, 'uncertain')
})

test('B9 every list is asked for THIS payment: the filter is on every page, and the answer holds none of the other payments\' refunds or disputes', async () => {
  const world = W()
  world.addRefund({ id: 're_own', amount: 5, status: 'pending' })
  for (let index = 1; index <= 4; index++) { world.addForeignRefund({ id: `re_foreign_${index}` }); world.addForeignDispute({ id: `dp_foreign_${index}` }) }
  const result = await read(world)
  assert.deepEqual(ids(result.evidence.refunds), ['re_own'])
  assert.deepEqual(ids(result.evidence.disputes), [])
  for (const call of [...world.callsOf('refunds.list'), ...world.callsOf('disputes.list')]) assert.equal(call.params.payment_intent, 'pi_t1')
})

// =====================================================================================================================================================================
// C. Refunds and their reversals
// =====================================================================================================================================================================
test('C1 a PENDING refund is already inside amount_refunded (AR-2 A): uncertain, 80..100; once it succeeded: proven 80 - every reading is independent of the last', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'pending' })
  const first = await read(world)
  assert.equal(world.callsOf('balanceTransactions.retrieve').length, 0, 'a pending refund has no balance transaction yet: nothing to read')
  assert.equal(first.evidence.charge?.amount_refunded, 20)
  const p1 = await position(first.evidence)
  assert.deepEqual([p1.certainty, p1.retainedLowerCents, p1.retainedUpperCents], ['uncertain', 80, 100])
  assert.ok(codes(p1).includes('uncertainty:refund_in_flight'))
  world.setRefundStatus('re_a', 'succeeded')
  const p2 = await position((await read(world)).evidence)
  assert.deepEqual([p2.certainty, p2.retainedLowerCents, p2.retainedUpperCents], ['proven', 80, 80])
})

test('C2 a refund that SUCCEEDED can FAIL (AR-2 B): 80 proven, then amount_refunded goes down to 0 and the refund shows -20 / +20 - the reader reads both movements and the funds model proves 100, final', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  const before = await position((await read(world)).evidence)
  assert.deepEqual([before.certainty, before.final, before.retainedLowerCents, before.retainedUpperCents], ['proven', false, 80, 80])
  world.failRefund('re_a')
  const result = await read(world)
  assert.equal(result.evidence.charge?.amount_refunded, 0)
  assert.deepEqual(world.callsOf('balanceTransactions.retrieve').slice(1).map((call) => call.id), ['txn_re_a', 'txn_f_re_a'])
  const after = await position(result.evidence)
  assert.deepEqual([after.certainty, after.final, after.retainedLowerCents, after.retainedUpperCents, after.refunds.reversedCents], ['proven', true, 100, 100, 20])
})

test('C3 a movement that is NOT read is not a movement that was seen: the reading is incomplete, BOTH lists are degraded, the ids stay ids, and the funds model is uncertain', async () => {
  const world = W()
  world.addRefund({ id: 're_f', amount: 20, status: 'failed' })
  const result = await read(world, { options: { maxMovementReads: 0 } })
  assert.equal(world.callsOf('balanceTransactions.retrieve').length, 0)
  assert.equal(result.reading.structure.parts.movements, 'unresolved')
  assert.equal(result.reading.structure.complete, false)
  assert.deepEqual(reasonsOf(result), ['movements_unresolved'])
  assert.equal(result.evidence.refunds?.has_more, true)
  assert.equal(result.evidence.disputes?.has_more, true)
  assert.equal(result.evidence.refunds?.data[0].balance_transaction, 'txn_re_f')
  assert.equal(result.evidence.refunds?.data[0].failure_balance_transaction, 'txn_f_re_f')
  assert.equal(result.reading.counts.unresolvedMovements, 2)
  assert.deepEqual(result.reading.failures, [{ call: 'balanceTransactions.retrieve', kind: 'budget', ref: 'movements' }])
  assert.deepEqual(result.reading.temporal.paymentIntentRecheck, 'not_done', 'the closing read is skipped when the structure is already incomplete')
  assert.equal(result.reading.temporal.observation, 'not_verifiable')
  assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve', 'refunds.list', 'disputes.list'])
  assert.equal((await position(result.evidence)).certainty, 'uncertain')
})

test('C3b the two movements of a failed refund are a pair: if the first cannot be read the second is not even asked for; both stay unresolved and the model says it cannot tell whether the money came back', async () => {
  const world = W()
  world.addRefund({ id: 're_f', amount: 20, status: 'failed' })
  world.transactions.delete('txn_re_f')
  const result = await read(world)
  assert.deepEqual(world.callsOf('balanceTransactions.retrieve').map((call) => call.id), ['txn_re_f'])
  assert.deepEqual(result.reading.failures, [{ call: 'balanceTransactions.retrieve', kind: 'invalid_request', statusCode: 404, code: 'resource_missing', ref: 'txn_re_f' }])
  assert.equal(result.reading.counts.unresolvedMovements, 2)
  assert.deepEqual(reasonsOf(result), ['movements_unresolved'])
  const p = await position(result.evidence)
  assert.ok(codes(p).includes('uncertainty:refund_movements_unreadable'))
})

test('C3c when the movements to read are capped, the pairs of the refunds that did NOT succeed come first (they decide whether money came back)', async () => {
  const world = W()
  world.addRefund({ id: 're_fail', amount: 20, status: 'failed' })   // the OLDER one: a list shows it last
  world.addRefund({ id: 're_ok', amount: 10, status: 'succeeded' })
  const result = await read(world, { options: { maxMovementReads: 1 } })
  assert.deepEqual(ids(result.evidence.refunds), ['re_ok', 're_fail'])
  assert.deepEqual(world.callsOf('balanceTransactions.retrieve').map((call) => call.id), ['txn_re_fail'])
  assert.equal(result.reading.structure.complete, false)
})

test('C4 every status is forwarded as it came (requires_action, canceled, one nobody modeled, none): nothing is filtered, mapped or guessed; the model reads them prudently', async () => {
  const cases: Array<[unknown, string]> = [['requires_action', 'uncertainty:refund_in_flight'], ['canceled', 'uncertainty:refund_reversal_unproven'], ['brand_new_status', 'uncertainty:refund_state_unknown'], [null, 'uncertainty:refund_state_unknown']]
  for (const [status, finding] of cases) {
    const world = W()
    world.addRefund({ id: 're_s', amount: 20, status: status === null ? 'succeeded' : (status as string), over: status === null ? { status: null } : {} })
    const result = await read(world)
    assert.equal(result.evidence.refunds?.data[0].status, status, `status ${String(status)} is forwarded as it is`)
    assert.equal(ids(result.evidence.refunds).length, 1)
    assert.ok(codes(await position(result.evidence)).includes(finding), `${String(status)} -> ${finding}`)
  }
})

test('C6 an aggregate that says MORE than the refunds listed explain is forwarded as it is - the reader does not correct it - and the funds model reports it', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  world.chargeOverride = { amount_refunded: 50 }
  const result = await read(world)
  assert.equal(result.evidence.charge?.amount_refunded, 50)
  assert.ok(codes(await position(result.evidence)).includes('uncertainty:refunded_amount_unexplained'))
})

test('C7 an amount_refunded that is ABSENT stays absent (it is not zero): the key is not there and the funds model says the total was not read', async () => {
  const world = W()
  world.chargeOverride = { amount_refunded: undefined }
  const result = await read(world)
  assert.ok(!('amount_refunded' in (result.evidence.charge as object)))
  assert.ok(codes(await position(result.evidence)).includes('uncertainty:refund_total_not_read'))
})

test('C8 the refunds the APPLICATION asked for are the caller\'s words, not Stripe\'s: COPIED (a new array of new objects), in the caller\'s order, duplicates kept, no de-duplication, no correction - the funds model judges them; what is not a list of requests is refused (section R)', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  const requested = [{ id: 're_req', amount: 30 }, { id: 're_req', amount: 30 }, { amount: 5, currency: 'eur' }, { id: 're_a', amount: 99 }]
  const before = JSON.stringify(requested)
  const result = await read(world, { request: { requestedRefunds: requested } })
  assert.deepStrictEqual(result.evidence.requestedRefunds, requested, 'the same words')
  assert.notStrictEqual(result.evidence.requestedRefunds, requested, 'but not the same array')
  result.evidence.requestedRefunds?.forEach((copy, index) => assert.notStrictEqual(copy, requested[index], `nor the same object (${index})`))
  assert.equal(JSON.stringify(requested), before, 'the caller\'s own value is not even touched')
  const found = codes(await position(result.evidence))
  for (const expected of ['conflict:conflicting_duplicate', 'uncertainty:refund_requested', 'note:duplicate_removed']) assert.ok(found.includes(expected), expected)
  // what is not a list of requests is no longer handed over for the funds model to find out: it is refused here, by name, before any call (R3 has the whole table)
  for (const odd of [null, 'oops', 7, [null, 3, { id: 5 }]]) {
    const again = await read(W(), { request: { requestedRefunds: odd } })
    assert.deepEqual(again.reading.failures, [{ call: 'input', kind: 'invalid_input', ref: 'requestedRefunds' }], JSON.stringify(odd))
    assert.ok(!('requestedRefunds' in again.evidence), `${JSON.stringify(odd)} left nothing in the evidence`)
  }
  assert.ok(!('requestedRefunds' in (await read(W())).evidence), 'when none was given there is no key (the reader does not say "none")')
  assert.ok(!('requestedRefunds' in (await read(W(), { request: { requestedRefunds: undefined } })).evidence))
})

test('C9 a movement that comes inline needs no call; the same movement cited by two refunds is read ONCE and the model still sees the id used twice', async () => {
  const inline = W()
  inline.addRefund({ id: 're_a', amount: 20, status: 'succeeded', over: { balance_transaction: { id: 'txn_inline', object: 'balance_transaction', amount: -20, currency: 'eur', fee: 0, net: -20, reporting_category: 'refund', source: 're_a' } } })
  const first = await read(inline)
  assert.equal(inline.callsOf('balanceTransactions.retrieve').length, 0)
  assert.equal(first.reading.structure.parts.movements, 'resolved')
  assert.deepEqual([first.reading.structure.complete, (await position(first.evidence)).retainedLowerCents], [true, 80])
  const shared = W()
  shared.addRefund({ id: 're_1', amount: 20, status: 'succeeded' })
  shared.addRefund({ id: 're_2', amount: 20, status: 'succeeded', over: { balance_transaction: 'txn_re_1' } })
  const second = await read(shared)
  assert.equal(shared.callsOf('balanceTransactions.retrieve').filter((call) => call.id === 'txn_re_1').length, 1)
  const sharedRefunds = second.evidence.refunds?.data as Rec[]
  assert.equal(sharedRefunds[0].balance_transaction.id, 'txn_re_1')
  assert.equal(sharedRefunds[1].balance_transaction.id, 'txn_re_1')
  assert.ok(codes(await position(second.evidence)).includes('conflict:conflicting_duplicate'))
})

test('C10 ANY id left unresolved - even the movement of a refund that succeeded - makes the reading incomplete (an id hides contradictions): never "proven 80"', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  const result = await read(world, { options: { maxMovementReads: 0 } })
  assert.deepEqual(reasonsOf(result), ['movements_unresolved'])
  assert.equal(result.evidence.refunds?.has_more, true)
  const p = await position(result.evidence)
  assert.equal(p.certainty, 'uncertain')
  assert.ok(codes(p).includes('uncertainty:refunds_incomplete'))
  const control = W()
  control.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  assert.equal((await position((await read(control)).evidence)).certainty, 'proven', 'the same world, fully read, is proven')
})

test('C11 a movement that CONTRADICTS its refund (amount, source, currency) is forwarded and the model reports the conflict; one that cannot be read leaves the reading incomplete - neither ever gives "proven 80"', async () => {
  const cases: Array<[string, (bt: Rec) => void, string]> = [
    ['an amount of -30 for a refund of 20', (bt) => { bt.amount = -30; bt.net = -30 }, 'conflict:balance_transaction_inconsistent'],
    ['a source that is another refund', (bt) => { bt.source = 're_other' }, 'conflict:foreign_evidence'],
    ['another currency', (bt) => { bt.currency = 'usd' }, 'conflict:currency_mismatch'],
  ]
  for (const [name, change, finding] of cases) {
    const world = W()
    world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
    change(world.transactions.get('txn_re_a') as Rec)
    const result = await read(world)
    assert.equal(result.reading.structure.complete, true, `${name}: the reading is complete - it is the evidence that contradicts itself`)
    const p = await position(result.evidence)
    assert.ok(codes(p).includes(finding), name)
    assert.deepEqual([p.certainty, p.retainedLowerCents, p.retainedUpperCents], ['uncertain', 0, 100], name)
  }
  const unreadable = W()
  unreadable.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  unreadable.transactions.delete('txn_re_a')
  const result = await read(unreadable)
  assert.equal(result.reading.structure.complete, false)
  assert.equal((await position(result.evidence)).certainty, 'uncertain')
})

test('C14 a movement that cannot be read is asked for ONCE however many refunds name it (a failure is not retried at the next citation); both slots stay unresolved', async () => {
  const world = W()
  world.addRefund({ id: 're_1', amount: 5, status: 'succeeded', over: { balance_transaction: 'txn_missing' } })
  world.addRefund({ id: 're_2', amount: 6, status: 'succeeded', over: { balance_transaction: 'txn_missing' } })
  world.addRefund({ id: 're_3', amount: 7, status: 'failed', over: { balance_transaction: 'txn_missing', failure_balance_transaction: 'txn_missing' } })
  const result = await read(world)
  assert.deepEqual(world.callsOf('balanceTransactions.retrieve').map((call) => call.id), ['txn_missing'])
  assert.equal(result.reading.counts.movementReads, 1)
  assert.equal(result.reading.counts.unresolvedMovements, 4)
  assert.deepEqual(result.reading.failures, [{ call: 'balanceTransactions.retrieve', kind: 'invalid_request', statusCode: 404, code: 'resource_missing', ref: 'txn_missing' }])
})

test('C13 a movement that comes INLINE must be a balance transaction with a usable id - otherwise it is unresolved; an id that cannot even be asked for (it is not an id) is unresolved too, and no call is made for it', async () => {
  const cases: Array<[string, unknown, unknown]> = [
    ['an object of another type', { id: 'txn_x', object: 'charge', amount: -20, currency: 'eur', fee: 0, net: -20, reporting_category: 'refund', source: 're_a' }, null],
    ['an object with no id', { object: 'balance_transaction', amount: -20, currency: 'eur', fee: 0, net: -20, reporting_category: 'refund', source: 're_a' }, null],
    ['an object with an id that is not one', { id: 'txn x', object: 'balance_transaction', amount: -20, currency: 'eur', fee: 0, net: -20, reporting_category: 'refund', source: 're_a' }, null],
    ['an id that cannot be asked for', 'txn bad id', null],
    ['something that is neither an id nor an object', 7, null],
  ]
  for (const [name, inline, failure] of cases) {
    const world = W()
    world.addRefund({ id: 're_a', amount: 20, status: 'succeeded', over: { balance_transaction: inline } })
    const result = await read(world)
    assert.equal(world.callsOf('balanceTransactions.retrieve').length, 0, `${name}: nothing to read`)
    assert.deepEqual(reasonsOf(result), ['movements_unresolved'], name)
    assert.equal(result.reading.counts.unresolvedMovements, 1, name)
    assert.equal(result.reading.structure.parts.movements, 'unresolved', name)
    assertFailClosed(result, name)
    void failure
  }
})

test('B7b a payment canceled WITHOUT a charge, whose refunds could not be read: "none reported" stays what it is and NO charge is made up when the closing read is not done', async () => {
  const world = W({ status: 'canceled', charge: null })
  world.fault('refunds.list', 1, fail.sdk(sdkErrors.api))
  const result = await read(world)
  assert.equal(result.evidence.charge, null)
  assert.equal(result.reading.structure.parts.charge, 'none_reported')
  assert.equal(result.reading.temporal.paymentIntentRecheck, 'not_done')
  assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve', 'refunds.list', 'disputes.list'])
})

test('H17 a payment flow the model does not know that shows up only at the CLOSING read (on the payment or on the charge) makes the structure incomplete although nothing that the model reads changed - and both lists are degraded', async () => {
  for (const [name, change] of [
    ['on the payment', (w: World) => { w.piOverride = { transfer_data: { destination: 'acct_x' } } }],
    ['on the charge', (w: World) => { w.chargeOverride = { application_fee_amount: 5 } }],
  ] as Array<[string, (w: World) => void]>) {
    const world = W()
    world.at('T3', change, name)
    const result = await read(world)
    assert.equal(result.reading.temporal.paymentIntentRecheck, 'same', name)
    assert.deepEqual(reasonsOf(result), ['payment_flow_not_modeled'], name)
    assert.equal(result.reading.structure.complete, false, name)
    assertFailClosed(result, name)
    assert.equal((await position(result.evidence)).certainty, 'uncertain', name)
  }
})

test('J10 the net and the fee of a movement come as they are, even when they contradict the amount: the reader does not recompute, the funds model reports the contradiction', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  Object.assign(world.transactions.get('txn_re_a') as Rec, { net: -999, fee: 7 })
  const result = await read(world)
  const movement = (result.evidence.refunds?.data[0] as Rec).balance_transaction
  assert.deepEqual([movement.amount, movement.fee, movement.net], [-20, 7, -999])
  assert.ok(codes(await position(result.evidence)).includes('conflict:balance_transaction_inconsistent'))
})

test('M17b a field that the answer holds as undefined stays absent too (undefined is not a value of Stripe\'s JSON): it is not turned into null or zero', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'pending' })
  world.fault('paymentIntents.retrieve', undefined, fail.transform((r) => { r.currency = undefined; r.latest_charge.amount_refunded = undefined; r.latest_charge.currency = undefined; return r }))
  world.fault('refunds.list', 1, fail.transform((page) => { page.data[0].currency = undefined; page.data[0].status = undefined; return page }))
  const result = await read(world)
  assert.ok(!('currency' in (result.evidence.paymentIntent as object)))
  assert.ok(!('amount_refunded' in (result.evidence.charge as object)) && !('currency' in (result.evidence.charge as object)))
  assert.ok(!('currency' in (result.evidence.refunds?.data[0] as object)) && !('status' in (result.evidence.refunds?.data[0] as object)))
})

// =====================================================================================================================================================================
// D. Disputes
// =====================================================================================================================================================================
test('D1 a dispute that is open (needs_response, under_review, warning_*) leaves the position uncertain: the disputed amount may be withdrawn or given back', async () => {
  for (const status of ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review']) {
    const world = W()
    world.addDispute({ id: 'dp_1', amount: 100, status })
    const p = await position((await read(world)).evidence)
    assert.equal(p.certainty, 'uncertain', status)
    assert.ok(codes(p).includes('uncertainty:dispute_open'), status)
  }
})

test('D2 a dispute "won" proves nothing about the funds: without the reinstatement it is "funds not returned"; read again after the reinstatement it is proven (every reading is independent)', async () => {
  const world = W()
  world.addDispute({ id: 'dp_1', amount: 100, status: 'won', reinstated: false })
  const first = await position((await read(world)).evidence)
  assert.equal(first.certainty, 'uncertain')
  assert.ok(codes(first).includes('uncertainty:dispute_won_funds_not_returned'))
  world.winDispute('dp_1')
  const second = await position((await read(world)).evidence)
  assert.deepEqual([second.certainty, second.retainedLowerCents, second.retainedUpperCents], ['proven', 100, 100])
})

test('D3 a dispute lost WITHOUT a withdrawal is not harmless; D4 a charge that says "disputed" with no dispute listed is reported by the model (the reader invents none); D5 a flag that says "not disputed" with a dispute listed is a conflict', async () => {
  const lost = W()
  lost.addDispute({ id: 'dp_1', amount: 100, status: 'lost', withdrawn: false })
  assert.ok(codes(await position((await read(lost)).evidence)).includes('uncertainty:dispute_lost_without_withdrawal'))
  const flagged = W()
  flagged.disputedFlag = true
  const result = await read(flagged)
  assert.deepEqual(result.evidence.disputes, { data: [], has_more: false }, 'no dispute is made up for the flag')
  assert.ok(codes(await position(result.evidence)).includes('uncertainty:disputed_charge_without_dispute'))
  const unflagged = W()
  unflagged.addDispute({ id: 'dp_1', amount: 100, status: 'lost' })
  unflagged.disputedFlag = false
  assert.ok(codes(await position((await read(unflagged)).evidence)).includes('conflict:dispute_flag_mismatch'))
})

test('D6 the movements of a dispute are inline objects: a string, a missing array or an element that is not a balance transaction is NOT read (no hydration) and makes the dispute list incomplete', async () => {
  const cases: Array<[string, (world: World) => void, number, string]> = [
    ['an element that is only an id', (world) => { world.inlineDisputeBts = false }, 1, 'uncertainty:dispute_movements_unreadable'],
    ['no array at all', (world) => { world.find('disputes', 'dp_1').balance_transactions = undefined }, 1, 'uncertainty:dispute_movements_not_read'],
    ['an element of another type', (world) => { world.find('disputes', 'dp_1').balance_transactions = [{ id: 'txn_x', object: 'charge', amount: -100, currency: 'eur', fee: 0, net: -100, reporting_category: 'dispute', source: 'dp_1' }] }, 1, ''],
    ['an object instead of an array (a secret in it must not travel)', (world) => { world.find('disputes', 'dp_1').balance_transactions = { client_secret: CANARIES.clientSecret } }, 1, 'uncertainty:dispute_movements_not_read'],
    ['an element with no id', (world) => { world.find('disputes', 'dp_1').balance_transactions = [{ object: 'balance_transaction', amount: -100, currency: 'eur', fee: 0, net: -100, reporting_category: 'dispute', source: 'dp_1' }] }, 1, ''],
    ['an element that is not an object at all', (world) => { world.find('disputes', 'dp_1').balance_transactions = [7, null] }, 2, ''],
  ]
  for (const [name, change, unresolved, finding] of cases) {
    const world = W()
    world.addDispute({ id: 'dp_1', amount: 100, status: 'lost' })
    change(world)
    const result = await read(world)
    assert.equal(world.callsOf('balanceTransactions.retrieve').length, 0, `${name}: the movements of a dispute are never hydrated`)
    assert.equal(result.reading.structure.parts.movements, 'unresolved', name)
    assert.deepEqual(reasonsOf(result), ['movements_unresolved'], name)
    assert.equal(result.reading.counts.unresolvedMovements, unresolved, name)
    assert.equal(result.evidence.disputes?.has_more, true, name)
    const p = await position(result.evidence)
    assert.equal(p.certainty, 'uncertain', name)
    if (finding) assert.ok(codes(p).includes(finding), name)
    assertNoCanary(result, name)
  }
})

test('D7 a reporting category nobody recognises is forwarded and the model refuses to guess; D8 several disputes are all forwarded, newest first; D9 statuses the model never saw are "not modeled"', async () => {
  const odd = W()
  odd.addDispute({ id: 'dp_1', amount: 100, status: 'lost' })
  ;(odd.transactions.get('txn_dpw_dp_1') as Rec).reporting_category = 'something_else'
  assert.ok(codes(await position((await read(odd)).evidence)).includes('conflict:unrecognized_movement'))
  const many = W()
  for (const id of ['dp_a', 'dp_b', 'dp_c']) many.addDispute({ id, amount: 10, status: 'lost' })
  assert.deepEqual(ids((await read(many)).evidence.disputes), ['dp_c', 'dp_b', 'dp_a'])
  for (const status of ['warning_closed', 'prevented', 'a_new_status']) {
    const world = W()
    world.addDispute({ id: 'dp_1', amount: 100, status })
    assert.ok(codes(await position((await read(world)).evidence)).includes('uncertainty:dispute_status_not_modeled'), status)
  }
})

// =====================================================================================================================================================================
// E. Pagination and incompleteness: a list is complete only if it was walked to its end
// =====================================================================================================================================================================
function refundsWorld(count: number, extra: ConstructorParameters<typeof World>[0] = {}) {
  const world = W({ amount: 100000, ...extra })
  for (let index = 1; index <= count; index++) world.addRefund({ id: `re_${index}`, amount: index, status: 'pending' })
  return world
}
test('E1 seven refunds in pages of two: four pages, the cursor is the last id of the page before, the order is the one Stripe gave, has_more is false only at the end', async () => {
  const world = refundsWorld(7)
  const result = await read(world, { options: { pageSize: 2 } })
  const calls = world.callsOf('refunds.list')
  assert.deepEqual(calls.map((call) => call.params), [
    { payment_intent: 'pi_t1', limit: 2 }, { payment_intent: 'pi_t1', limit: 2, starting_after: 're_6' }, { payment_intent: 'pi_t1', limit: 2, starting_after: 're_4' }, { payment_intent: 'pi_t1', limit: 2, starting_after: 're_2' },
  ])
  assert.deepEqual(ids(result.evidence.refunds), ['re_7', 're_6', 're_5', 're_4', 're_3', 're_2', 're_1'])
  assert.equal(result.evidence.refunds?.has_more, false)
  assert.equal(result.reading.counts.refundPages, 4)
  assert.equal(result.reading.structure.parts.refunds, 'complete')
  assert.equal(result.reading.temporal.pagination, 'regular')
})

test('E2 the cap on pages is reached with more to read: what was read is kept, has_more stays TRUE, the part is incomplete, and the model sees an incomplete list (never a complete one)', async () => {
  const world = refundsWorld(7)
  const result = await read(world, { options: { pageSize: 2, maxPages: 2 } })
  assert.deepEqual(ids(result.evidence.refunds), ['re_7', 're_6', 're_5', 're_4'])
  assert.equal(result.evidence.refunds?.has_more, true)
  assert.equal(result.reading.structure.parts.refunds, 'incomplete')
  assert.deepEqual(reasonsOf(result), ['refunds_truncated'])
  assert.deepEqual(result.reading.failures, [{ call: 'refunds.list', kind: 'budget', page: 3, ref: 'pages' }])
  assert.equal(world.callsOf('refunds.list').length, 2)
  assert.ok(codes(await position(result.evidence)).includes('uncertainty:refunds_incomplete'))
})

test('E3 page 1 read, page 2 fails: the first page is kept and the list is INCOMPLETE (not null, not complete); E4 page 1 fails: null (never an empty list), and the disputes are still read', async () => {
  const half = refundsWorld(5)
  half.fault('refunds.list', 2, fail.sdk(sdkErrors.rateLimit))
  const result = await read(half, { options: { pageSize: 2 } })
  assert.deepEqual(ids(result.evidence.refunds), ['re_5', 're_4'])
  assert.equal(result.evidence.refunds?.has_more, true)
  assert.deepEqual(result.reading.failures, [{ call: 'refunds.list', kind: 'rate_limit', page: 2, statusCode: 429 }])
  assert.deepEqual(reasonsOf(result), ['refunds_truncated'])
  const none = refundsWorld(5)
  none.fault('refunds.list', 1, fail.sdk(sdkErrors.api))
  const second = await read(none)
  assert.equal(second.evidence.refunds, null)
  assert.notEqual(second.evidence.disputes, null)
  assert.equal(second.reading.structure.parts.refunds, 'not_read')
  assert.deepEqual(reasonsOf(second), ['refunds_not_read'])
  assert.deepEqual(second.reading.failures, [{ call: 'refunds.list', kind: 'api', page: 1, statusCode: 500 }])
  assert.deepEqual(methodsOf(none), ['paymentIntents.retrieve', 'refunds.list', 'disputes.list'])
})

const MALFORMED_PAGES: Array<[string, (page: any) => unknown]> = [
  ['a string instead of a list', () => 'oops'],
  ['null', () => null],
  ['an array', () => []],
  ['no data', (page) => { delete page.data; return page }],
  ['data that is not an array', (page) => { page.data = { 0: 'x' }; return page }],
  ['no has_more', (page) => { delete page.has_more; return page }],
  ['a has_more that is not a boolean', (page) => { page.has_more = 'false'; return page }],
  ['a has_more that is null', (page) => { page.has_more = null; return page }],
  ['more elements than the limit', (page) => { page.data = [...page.data, ...page.data, ...page.data]; return page }],
  ['has_more with an empty page', (page) => { page.data = []; page.has_more = true; return page }],
]
test('E5 a page that is not a page (a string, null, no data, no has_more, a has_more that is not a boolean, more than the limit, "more" with nothing in it) is never a list: page 1 -> null; later -> what was read, INCOMPLETE', async () => {
  for (const [name, change] of MALFORMED_PAGES) {
    const first = refundsWorld(5)
    first.fault('refunds.list', 1, fail.transform(change))
    const result = await read(first, { options: { pageSize: 2 } })
    assert.equal(result.evidence.refunds, null, `${name} on page 1`)
    assert.equal(result.reading.failures[0].kind, 'malformed_response', name)
    assert.deepEqual(reasonsOf(result), ['refunds_not_read'], name)
    const later = refundsWorld(5)
    later.fault('refunds.list', 2, fail.transform(change))
    const partial = await read(later, { options: { pageSize: 2 } })
    assert.deepEqual(ids(partial.evidence.refunds), ['re_5', 're_4'], `${name} on page 2`)
    assert.equal(partial.evidence.refunds?.has_more, true, name)
    assert.deepEqual(reasonsOf(partial), ['refunds_truncated'], name)
  }
})

test('E6 "more to read" but the last element has no usable id: the cursor cannot be built, so the page is kept and the list is incomplete', async () => {
  for (const bad of [undefined, null, 5, 'a b', '']) {
    const world = refundsWorld(5)
    world.fault('refunds.list', 1, fail.transform((page) => { page.data[page.data.length - 1].id = bad; return page }))
    const result = await read(world, { options: { pageSize: 2 } })
    assert.equal(result.evidence.refunds?.data.length, 2, `a last id ${JSON.stringify(bad)}`)
    assert.equal(result.evidence.refunds?.has_more, true)
    assert.deepEqual(result.reading.failures, [{ call: 'refunds.list', kind: 'malformed_response', page: 1, ref: 'cursor' }])
    assert.equal(world.callsOf('refunds.list').length, 1)
  }
})

test('E7 a cursor that does not advance (the same page again and again) ends the walk after the second page: incomplete, the repetition is reported, and the number of calls is not the cap', async () => {
  const world = refundsWorld(9)
  const stuck = JSON.parse(JSON.stringify(await world.client().refunds.list({ payment_intent: world.piId, limit: 2 })))
  world.calls.length = 0
  world.fault('refunds.list', undefined, () => ok(clone(stuck)))
  const result = await read(world, { options: { pageSize: 2, maxPages: 5 } })
  assert.equal(world.callsOf('refunds.list').length, 2)
  assert.equal(result.evidence.refunds?.has_more, true)
  assert.equal(result.reading.temporal.pagination, 'anomalous')
  assert.deepEqual(reasonsOf(result), ['refunds_truncated'])
})

test('E8 the same refund on two pages (the order moved under the walk): BOTH are forwarded as they came, the walk is reported as anomalous, the reading "changed", and BOTH lists are degraded', async () => {
  const world = refundsWorld(4)
  world.fault('refunds.list', 2, () => ok({ object: 'list', has_more: false, url: '/v1/refunds', data: [clone(world.find('refunds', 're_3')), clone(world.find('refunds', 're_2'))] }))
  const result = await read(world, { options: { pageSize: 2 } })
  assert.deepEqual(ids(result.evidence.refunds), ['re_4', 're_3', 're_3', 're_2'])
  assert.equal(result.reading.temporal.pagination, 'anomalous')
  assert.ok(result.reading.temporal.signals.includes('pagination_anomaly'))
  assert.equal(result.reading.temporal.observation, 'change_observed')
  assert.equal(result.reading.structure.complete, true, 'the lists were walked to their end')
  assert.equal(result.evidence.refunds?.has_more, true)
  assert.equal(result.evidence.disputes?.has_more, true)
  const p = await position(result.evidence)
  assert.equal(p.certainty, 'uncertain')
  assert.ok(codes(p).includes('note:duplicate_removed'), 'identical duplicates would have been counted once and called proven by the model alone')
})

test('E9 the limit is always 1..100 whatever the options, and the first page never carries a cursor', async () => {
  for (const size of [1, 2, 50, 100]) {
    const world = refundsWorld(3)
    await read(world, { options: { pageSize: size } })
    for (const call of [...world.callsOf('refunds.list'), ...world.callsOf('disputes.list')]) assert.equal(call.params.limit, size)
    assert.ok(!('starting_after' in world.callsOf('refunds.list')[0].params))
  }
  const defaults = refundsWorld(3)
  await read(defaults)
  assert.equal(defaults.callsOf('refunds.list')[0].params.limit, 100)
})

test('E10 a thousand refunds in pages of a hundred: the default cap of five pages keeps 500 and says so; a cap of fifty walks all ten pages and says it is complete', async () => {
  const world = refundsWorld(1000)
  const capped = await read(world)
  assert.equal(capped.evidence.refunds?.data.length, 500)
  assert.equal(capped.evidence.refunds?.has_more, true)
  assert.deepEqual(reasonsOf(capped), ['refunds_truncated'])
  const more = refundsWorld(1000)
  const full = await read(more, { options: { maxPages: 50 } })
  assert.equal(full.evidence.refunds?.data.length, 1000)
  assert.equal(full.evidence.refunds?.has_more, false)
  assert.equal(full.reading.counts.refundPages, 10)
  assert.equal(full.reading.structure.complete, true)
})

// =====================================================================================================================================================================
// F. Belonging, duplicates, currencies, identity, the payment flow
// =====================================================================================================================================================================
test('F1 a refund Stripe lists that names ANOTHER payment is forwarded as it came - the reader does not filter in silence - and the model sets it aside', async () => {
  const world = W()
  world.addRefund({ id: 're_x', amount: 5, status: 'pending', over: { payment_intent: 'pi_other' } })
  const result = await read(world)
  assert.deepEqual(ids(result.evidence.refunds), ['re_x'])
  assert.equal(result.evidence.refunds?.data[0].payment_intent, 'pi_other')
  assert.ok(codes(await position(result.evidence)).includes('conflict:foreign_evidence'))
})

test('F2 the SDK trap is not in the reader: with refunds and disputes of OTHER payments in the account, nothing foreign is ever read (the filter reaches Stripe on every page)', async () => {
  const world = refundsWorld(5)
  for (let index = 1; index <= 15; index++) { world.addForeignRefund({ id: `re_foreign_${index}` }); world.addForeignDispute({ id: `dp_foreign_${index}` }) }
  const result = await read(world, { options: { pageSize: 2, maxPages: 10 } })
  assert.ok(ids(result.evidence.refunds).every((id) => !id.includes('foreign')) && ids(result.evidence.disputes).length === 0)
  assert.equal(ids(result.evidence.refunds).length, 5)
})

test('F3 a charge that names ANOTHER payment is not evidence: it is withheld, the reading is incomplete (charge_identity) and both lists are degraded', async () => {
  const world = W()
  world.chargeOverride = { payment_intent: 'pi_other' }
  const result = await read(world)
  assert.equal(result.evidence.charge, null)
  assert.equal(result.reading.structure.parts.charge, 'withheld')
  assert.deepEqual(reasonsOf(result), ['charge_identity'])
  assertFailClosed(result, 'F3')
  assert.equal((await position(result.evidence)).certainty, 'uncertain')
})

test('F4 currencies are never converted, never case-folded: a refund in another currency is a conflict for the model, and "EUR" stays "EUR" in the evidence', async () => {
  const other = W()
  other.addRefund({ id: 're_u', amount: 5, status: 'pending', currency: 'usd' })
  assert.ok(codes(await position((await read(other)).evidence)).includes('conflict:currency_mismatch'))
  const upper = W()
  upper.addRefund({ id: 're_e', amount: 5, status: 'pending', currency: 'EUR' })
  assert.equal((await read(upper)).evidence.refunds?.data[0].currency, 'EUR')
})

test('F6 a balance transaction that is not the one asked for (another id, another type, not an object) is not accepted: the id stays an id and the movement is unresolved', async () => {
  const cases: Array<[string, (bt: any) => unknown, string]> = [
    ['another id', (bt) => ({ ...bt, id: 'txn_other' }), 'identity_mismatch'],
    ['another type', (bt) => ({ ...bt, object: 'charge' }), 'identity_mismatch'],
    ['no type', (bt) => { delete bt.object; return bt }, 'identity_mismatch'],
    ['a string', () => 'txn_re_a', 'malformed_response'],
    ['null', () => null, 'malformed_response'],
  ]
  for (const [name, change, kind] of cases) {
    const world = W()
    world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
    world.fault('balanceTransactions.retrieve', undefined, fail.transform(change))
    const result = await read(world)
    assert.equal(result.evidence.refunds?.data[0].balance_transaction, 'txn_re_a', name)
    assert.deepEqual(result.reading.failures, [{ call: 'balanceTransactions.retrieve', kind, ref: 'txn_re_a' }], name)
    assert.deepEqual(reasonsOf(result), ['movements_unresolved'], name)
  }
})

test('F7 a payment that is not the one asked for (another id, another type) is not read: ONE call, nothing else asked, everything "not read"', async () => {
  for (const over of [{ id: 'pi_other' }, { object: 'charge' }, { object: undefined }, { id: undefined }]) {
    const world = W()
    world.piOverride = over
    const result = await read(world)
    assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'], JSON.stringify(over))
    assert.deepEqual(result.evidence, { paymentIntent: null, charge: null, refunds: null, disputes: null })
    assert.deepEqual(reasonsOf(result), ['payment_intent_identity'])
    assert.deepEqual(result.reading.failures, [{ call: 'paymentIntents.retrieve', kind: 'identity_mismatch' }])
    assert.equal(result.reading.structure.parts.paymentIntent, 'not_read')
  }
})

test('F9 a payment flow the model does not know (a transfer, an "on behalf of" account, an application fee - on the payment or on the charge) makes the reading incomplete: who holds the funds is not shown', async () => {
  const overrides: Array<[string, (world: World) => void]> = [
    ['transfer_data on the payment', (world) => { world.piOverride = { transfer_data: { destination: 'acct_x' } } }],
    ['on_behalf_of on the payment', (world) => { world.piOverride = { on_behalf_of: 'acct_x' } }],
    ['an application fee on the payment', (world) => { world.piOverride = { application_fee_amount: 50 } }],
    ['an application fee of zero on the payment', (world) => { world.piOverride = { application_fee_amount: 0 } }],
    ['transfer_data on the charge', (world) => { world.chargeOverride = { transfer_data: { destination: 'acct_x' } } }],
    ['on_behalf_of on the charge', (world) => { world.chargeOverride = { on_behalf_of: 'acct_x' } }],
    ['an application fee on the charge', (world) => { world.chargeOverride = { application_fee_amount: 10 } }],
  ]
  for (const [name, change] of overrides) {
    const world = W()
    world.addRefund({ id: 're_a', amount: 20, status: 'pending' })
    change(world)
    const result = await read(world)
    assert.deepEqual(reasonsOf(result), ['payment_flow_not_modeled'], name)
    assert.equal(result.reading.structure.complete, false, name)
    assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve', 'refunds.list', 'disputes.list'], `${name}: no closing read when the structure is already incomplete`)
    assert.ok(result.evidence.paymentIntent !== null && result.evidence.refunds !== null, `${name}: what was read is still handed over`)
    assertFailClosed(result, name)
    assert.equal((await position(result.evidence)).certainty, 'uncertain', name)
  }
  const plain = W()
  assert.equal((await read(plain)).reading.structure.complete, true, 'nulls (what Stripe sends for a plain payment) are not a flow')
})

// =====================================================================================================================================================================
// G. Reads that fail, input that is not valid, and TIME: what is bounded, and what is not
// =====================================================================================================================================================================
async function readRaw(client: unknown, request: unknown, options: unknown) {
  const { readStripeFundsEvidence } = await load()
  return readStripeFundsEvidence(client as StripeFundsClient, request as FundsReadRequest, options as FundsReadOptions)
}
const hostileError: any = {}
Object.defineProperty(hostileError, 'type', { get() { throw new Error(CANARIES.errorText) } })
Object.defineProperty(hostileError, 'statusCode', { get() { throw new Error(CANARIES.errorText) } })
type Act = (call: CallInfo, normal: () => Outcome) => Outcome
const ERROR_CASES: Array<[string, Act, Rec]> = [
  ['rate limit (429)', fail.sdk(sdkErrors.rateLimit), { kind: 'rate_limit', statusCode: 429 }],
  ['api error (500)', fail.sdk(sdkErrors.api), { kind: 'api', statusCode: 500 }],
  ['timeout (the SDK\'s connection error with ETIMEDOUT)', fail.sdk(() => sdkErrors.timeout(5000)), { kind: 'timeout', code: 'ETIMEDOUT' }],
  ['connection error', fail.sdk(sdkErrors.connection), { kind: 'connection' }],
  ['authentication (401)', fail.sdk(sdkErrors.authentication), { kind: 'authentication', statusCode: 401 }],
  ['permission (403)', fail.sdk(sdkErrors.permission), { kind: 'permission', statusCode: 403 }],
  ['not found (404, resource_missing)', fail.sdk(() => sdkErrors.notFound('refund', 'x')), { kind: 'invalid_request', statusCode: 404, code: 'resource_missing' }],
  ['invalid request (400)', fail.sdk(() => sdkErrors.invalidRequest()), { kind: 'invalid_request', statusCode: 400 }],
  ['a string', fail.reject(`boom ${CANARIES.errorText}`), { kind: 'unknown' }],
  ['null', fail.reject(null), { kind: 'unknown' }],
  ['a number', fail.reject(42), { kind: 'unknown' }],
  ['a plain Error', fail.reject(new Error(CANARIES.errorText)), { kind: 'unknown' }],
  ['an error whose properties throw when read', fail.reject(hostileError), { kind: 'unknown' }],
  ['an error of the API with a code that is free text (not echoed)', fail.reject(Object.assign(new Error(CANARIES.errorText), { type: 'StripeInvalidRequestError', statusCode: 400, code: CANARIES.errorText })), { kind: 'invalid_request', statusCode: 400 }],
  ['an error with a status that is no HTTP status (not echoed)', fail.reject({ type: 'StripeAPIError', statusCode: 99999, code: 'api_error_x' }), { kind: 'api' }],
  ['an error with no type, by its status: 401', fail.reject({ statusCode: 401 }), { kind: 'authentication', statusCode: 401 }],
  ['an error with no type, by its status: 403', fail.reject({ statusCode: 403 }), { kind: 'permission', statusCode: 403 }],
  ['an error with no type, by its status: 404', fail.reject({ statusCode: 404 }), { kind: 'invalid_request', statusCode: 404 }],
  ['an error with no type, by its status: 429', fail.reject({ statusCode: 429 }), { kind: 'rate_limit', statusCode: 429 }],
  ['an error with no type, by its status: 503', fail.reject({ statusCode: 503 }), { kind: 'api', statusCode: 503 }],
  ['an error with no type, by the type of the API', fail.reject({ rawType: 'api_error' }), { kind: 'api' }],
  ['an error with a code of the connection layer (echoed: a name, not text)', fail.reject({ type: 'StripeConnectionError', detail: { code: 'ECONNRESET' } }), { kind: 'connection', code: 'ECONNRESET' }],
  ['an error with a status that is a string (not echoed)', fail.reject({ type: 'StripeRateLimitError', statusCode: '429' }), { kind: 'rate_limit' }],
  ['a synchronous throw', fail.throwSync(new Error(CANARIES.errorText)), { kind: 'unknown' }],
  ['a synchronous throw of a string', fail.throwSync(CANARIES.errorText), { kind: 'unknown' }],
]
test('G1 every kind of failure of a call - the SDK\'s own error classes included - becomes a classified failure with NO text of the error; the call that failed is "not read", never "empty"', async () => {
  for (const [name, act, expected] of ERROR_CASES) {
    const onList = refundsWorld(3)
    onList.fault('refunds.list', 1, act)
    const list = await read(onList)
    assert.equal(list.evidence.refunds, null, name)
    assert.deepEqual(list.reading.failures, [{ call: 'refunds.list', page: 1, ...expected }], name)
    assertNoCanary(list, name)
    assertFailClosed(list, name)
    const onPayment = W()
    onPayment.fault('paymentIntents.retrieve', 1, act)
    const payment = await read(onPayment)
    assert.deepEqual(payment.reading.failures, [{ call: 'paymentIntents.retrieve', ...expected }], name)
    assert.deepEqual(payment.evidence, { paymentIntent: null, charge: null, refunds: null, disputes: null }, name)
    assertNoCanary(payment, name)
    const onMovement = W()
    onMovement.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
    onMovement.fault('balanceTransactions.retrieve', 1, act)
    const movement = await read(onMovement)
    assert.deepEqual(movement.reading.failures, [{ call: 'balanceTransactions.retrieve', ref: 'txn_re_a', ...expected }], name)
    assert.equal(movement.evidence.refunds?.data[0].balance_transaction, 'txn_re_a', name)
    assertNoCanary(movement, name)
  }
})

test('G1b an answer that is not an object at all (undefined, null, a string, a number, a boolean, an array) is a malformed response; an empty object is a list without data or a payment without an id', async () => {
  for (const value of [undefined, null, 'oops', 5, true, []]) {
    const world = W()
    for (const method of METHODS) world.fault(method, undefined, fail.resolve(value))
    const result = await read(world)
    assert.equal(result.reading.failures[0].kind, 'malformed_response', JSON.stringify(value))
    assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'])
  }
  const empty = W()
  empty.fault('paymentIntents.retrieve', undefined, fail.resolve({}))
  assert.equal((await read(empty)).reading.failures[0].kind, 'identity_mismatch')
  const lists = W()
  lists.fault('refunds.list', undefined, fail.resolve({}))
  lists.fault('disputes.list', undefined, fail.resolve({}))
  const result = await read(lists)
  assert.deepEqual([result.evidence.refunds, result.evidence.disputes], [null, null])
  assert.deepEqual(result.reading.failures.map((entry) => entry.kind), ['malformed_response', 'malformed_response'])
})

test('G2 a payment that cannot be read stops everything: ONE call, nothing else asked, every part "not read", the closing read not done, and the list of what nobody verified is still there', async () => {
  const world = W()
  world.fault('paymentIntents.retrieve', undefined, fail.sdk(sdkErrors.rateLimit))
  const result = await read(world)
  const mod = await load()
  assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'])
  assert.deepEqual(result.evidence, { paymentIntent: null, charge: null, refunds: null, disputes: null })
  assert.deepEqual(result.reading.structure, { complete: false, parts: { paymentIntent: 'not_read', charge: 'not_read', refunds: 'not_read', disputes: 'not_read', movements: 'not_needed', mode: 'unverified' }, incomplete: ['payment_intent_not_read'] })
  assert.equal(result.reading.temporal.observation, 'not_verifiable')
  assert.equal(result.reading.temporal.paymentIntentRecheck, 'not_done')
  assert.deepEqual(result.reading.temporal.signals, ['payment_intent_unverified'])
  assert.equal(result.reading.temporal.notVerified, mod.FUNDS_READ_NOT_VERIFIED)
  assert.deepEqual(result.reading.mode, { expected: false, observed: 'unknown' })
  assert.equal(result.reading.counts.calls, 1)
  assert.equal((await position(result.evidence)).certainty, 'uncertain')
})

test('G4 a movement that cannot be read stays an id; G3 the disputes are read even when the refunds could not be', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  world.addDispute({ id: 'dp_1', amount: 50, status: 'lost' })
  world.fault('refunds.list', undefined, fail.sdk(sdkErrors.connection))
  const result = await read(world)
  assert.equal(result.evidence.refunds, null)
  assert.deepEqual(ids(result.evidence.disputes), ['dp_1'])
  assertFailClosed(result, 'G3')
})

const BAD_INPUTS: Array<[string, Extras, string]> = [
  ['no payment id', { request: { paymentIntentId: undefined } }, 'paymentIntentId'],
  ['a payment id that is a number', { request: { paymentIntentId: 12345 } }, 'paymentIntentId'],
  ['an empty payment id', { request: { paymentIntentId: '' } }, 'paymentIntentId'],
  ['an id of another kind of object', { request: { paymentIntentId: 'cs_test_1' } }, 'paymentIntentId'],
  ['an id with a space', { request: { paymentIntentId: 'pi_ 1' } }, 'paymentIntentId'],
  ['an id that is only the prefix', { request: { paymentIntentId: 'pi_' } }, 'paymentIntentId'],
  ['an id that is far too long', { request: { paymentIntentId: `pi_${'a'.repeat(300)}` } }, 'paymentIntentId'],
  ['an id that looks like a path', { request: { paymentIntentId: 'pi_1/../x' } }, 'paymentIntentId'],
  ['an id with a newline', { request: { paymentIntentId: 'pi_1\nx' } }, 'paymentIntentId'],
  ['no expected mode', { request: { expectedLivemode: undefined } }, 'expectedLivemode'],
  ['an expected mode that is the string "true"', { request: { expectedLivemode: 'true' } }, 'expectedLivemode'],
  ['an expected mode that is 1', { request: { expectedLivemode: 1 } }, 'expectedLivemode'],
  ['an expected mode that is 0', { request: { expectedLivemode: 0 } }, 'expectedLivemode'],
  ['an expected mode that is null', { request: { expectedLivemode: null } }, 'expectedLivemode'],
  ['an expected mode that is an object', { request: { expectedLivemode: {} } }, 'expectedLivemode'],
  ['a per-call timeout that is NaN', { options: { perCallTimeoutMs: Number.NaN } }, 'perCallTimeoutMs'],
  ['a per-call timeout that is negative', { options: { perCallTimeoutMs: -1 } }, 'perCallTimeoutMs'],
  ['a per-call timeout of zero', { options: { perCallTimeoutMs: 0 } }, 'perCallTimeoutMs'],
  ['a per-call timeout that is a string', { options: { perCallTimeoutMs: '5000' } }, 'perCallTimeoutMs'],
  ['a per-call timeout below the minimum', { options: { perCallTimeoutMs: 499 } }, 'perCallTimeoutMs'],
  ['a per-call timeout above the maximum', { options: { perCallTimeoutMs: 60001 } }, 'perCallTimeoutMs'],
  ['a per-call timeout that is not an integer', { options: { perCallTimeoutMs: 1500.5 } }, 'perCallTimeoutMs'],
  ['a per-call timeout that is null', { options: { perCallTimeoutMs: null } }, 'perCallTimeoutMs'],
  ['a deadline below the minimum', { options: { deadlineMs: 999 } }, 'deadlineMs'],
  ['a deadline above the maximum', { options: { deadlineMs: 120001 } }, 'deadlineMs'],
  ['a deadline that is Infinity', { options: { deadlineMs: Number.POSITIVE_INFINITY } }, 'deadlineMs'],
  ['a page size of zero', { options: { pageSize: 0 } }, 'pageSize'],
  ['a page size above 100', { options: { pageSize: 101 } }, 'pageSize'],
  ['a page size that is a string', { options: { pageSize: '10' } }, 'pageSize'],
  ['a maximum of pages of zero', { options: { maxPages: 0 } }, 'maxPages'],
  ['a maximum of pages above 50', { options: { maxPages: 51 } }, 'maxPages'],
  ['a negative maximum of movement reads', { options: { maxMovementReads: -1 } }, 'maxMovementReads'],
  ['a maximum of movement reads above 100', { options: { maxMovementReads: 101 } }, 'maxMovementReads'],
  ['a clock that is not a function', { options: { now: 5 } }, 'now'],
  ['no clock', { options: { now: undefined } }, 'now'],
  ['a clock that answers NaN', { options: { now: () => Number.NaN } }, 'now'],
  ['a clock that answers a string', { options: { now: () => '1800000000000' } }, 'now'],
  ['a clock that throws', { options: { now: () => { throw new Error(CANARIES.errorText) } } }, 'now'],
]
test('G8 any input that is not valid is refused WITHOUT a single call and without being repaired: it is reported by NAME (never by value), and nothing is read', async () => {
  for (const [name, extras, ref] of BAD_INPUTS) {
    const world = W()
    const { client, touched } = world.trapClient()
    const result = await read(world, { ...extras, client })
    assert.deepEqual(world.calls, [], `${name}: a call was made`)
    assert.ok(touched.every((entry) => ['paymentIntents', 'paymentIntents.retrieve', 'refunds', 'refunds.list', 'disputes', 'disputes.list', 'balanceTransactions', 'balanceTransactions.retrieve'].includes(entry)), `${name}: the client was touched beyond looking for its four methods`)
    assert.deepEqual(result.reading.failures, [{ call: 'input', kind: 'invalid_input', ref }], name)
    assert.deepEqual(result.evidence, { paymentIntent: null, charge: null, refunds: null, disputes: null }, name)
    assert.deepEqual(result.reading.structure, { complete: false, parts: { paymentIntent: 'not_read', charge: 'not_read', refunds: 'not_read', disputes: 'not_read', movements: 'not_needed', mode: 'unverified' }, incomplete: ['invalid_input'] }, name)
    assert.equal(result.reading.temporal.observation, 'not_verifiable', name)
    assert.equal(result.reading.temporal.paymentIntentRecheck, 'not_done', name)
    assert.deepEqual([result.reading.temporal.startedAtMs, result.reading.temporal.finishedAtMs, result.reading.temporal.spanMs, result.reading.temporal.withinDeadline], [null, null, null, null], name)
    assert.deepEqual(result.reading.counts, { calls: 0, refundPages: 0, disputePages: 0, movementReads: 0, unresolvedMovements: 0 }, name)
    assert.equal(result.reading.mode.expected, ref === 'expectedLivemode' ? null : false, name)
    assert.equal(result.reading.mode.observed, 'unknown', name)
    assertNoCanary(result, name)
  }
})

test('G8b what is not an object, a function or a client is refused too (the request, the options, the client, its methods) - every problem is listed, the order of the report is the order of the arguments', async () => {
  const world = W()
  const good = { paymentIntentId: 'pi_t1', expectedLivemode: false }
  const opts = { now: world.clock.now }
  for (const [name, args, refs] of [
    ['no request', [world.client(), undefined, opts], ['request']],
    ['a request that is null', [world.client(), null, opts], ['request']],
    ['a request that is a string', [world.client(), 'pi_t1', opts], ['request']],
    ['a request that is an array', [world.client(), [], opts], ['request']],
    ['no options', [world.client(), good, undefined], ['options']],
    ['options that are null', [world.client(), good, null], ['options']],
    ['options that are a string', [world.client(), good, 'x'], ['options']],
    ['no client', [undefined, good, opts], ['client']],
    ['a client that is {}', [{}, good, opts], ['client']],
    ['a client without refunds.list', [{ paymentIntents: { retrieve: () => ({}) }, disputes: { list: () => ({}) }, balanceTransactions: { retrieve: () => ({}) } }, good, opts], ['client']],
    ['a client whose method is not a function', [{ ...world.client(), refunds: { list: 'no' } }, good, opts], ['client']],
    ...(['paymentIntents', 'refunds', 'disputes', 'balanceTransactions'] as const).map((namespace): [string, unknown[], string[]] => {
      const client: Rec = { ...world.client() }
      client[namespace] = {}
      return [`a client without ${namespace}`, [client, good, opts], ['client']]
    }),
    ['three problems at once', [{}, { paymentIntentId: 7, expectedLivemode: 'x' }, { now: 1, pageSize: 0 }], ['client', 'paymentIntentId', 'expectedLivemode', 'now', 'pageSize']],
  ] as Array<[string, unknown[], string[]]>) {
    const result = await readRaw(args[0], args[1], args[2])
    assert.deepEqual(result.reading.failures.map((entry) => [entry.call, entry.kind, entry.ref]), refs.map((ref) => ['input', 'invalid_input', ref]), name)
    assert.deepEqual(result.reading.structure.incomplete, ['invalid_input'], name)
  }
  assert.deepEqual(world.calls, [])
})

test('G8c a value of the options at the very edge of its range is valid (none is refused or changed): 500/60000 ms, 1000/120000 ms, 1/100 per page, 1/50 pages, 0/100 movement reads', async () => {
  const edges: Array<Record<string, number>> = [{ perCallTimeoutMs: 500 }, { perCallTimeoutMs: 60000 }, { deadlineMs: 1000 }, { deadlineMs: 120000 }, { pageSize: 1 }, { pageSize: 100 }, { maxPages: 1 }, { maxPages: 50 }, { maxMovementReads: 0 }, { maxMovementReads: 100 }]
  for (const options of edges) {
    const world = W()
    const result = await read(world, { options })
    assert.ok(!result.reading.failures.some((entry) => entry.kind === 'invalid_input'), JSON.stringify(options))
    assert.ok(world.calls.length >= 1, JSON.stringify(options))
  }
})

test('G5 when less than the margin of the deadline is left, no call is started: the part is "not read", the budget is the reason, and the report says which calls were not made', async () => {
  const world = W({ latencyMs: 600 })
  world.honorTimeout = false
  const result = await read(world, { options: { deadlineMs: 1000 } })
  assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'])
  assert.deepEqual(result.reading.failures, [{ call: 'refunds.list', kind: 'budget', page: 1, ref: 'deadline' }, { call: 'disputes.list', kind: 'budget', page: 1, ref: 'deadline' }])
  assert.deepEqual(reasonsOf(result), ['budget_exhausted'])
  assert.equal(result.evidence.refunds, null)
  assert.equal(result.evidence.disputes, null)
  assert.equal(result.reading.temporal.observation, 'not_verifiable')
  assert.equal(result.reading.temporal.paymentIntentRecheck, 'not_done')
  assertFailClosed(result, 'G5')
})

test('G6 the timeout of EVERY call is min(per-call, (what is left of the deadline - 500) / 2, rounded down): an explicit integer, never omitted, never zero, never larger than half of what is left', async () => {
  for (const options of [{}, { perCallTimeoutMs: 1000, deadlineMs: 6000 }, { perCallTimeoutMs: 700, deadlineMs: 20000 }]) {
    const world = W({ latencyMs: 300 })
    for (let index = 1; index <= 8; index++) world.addRefund({ id: `re_${index}`, amount: index, status: 'succeeded' })
    const start = world.clock.now()
    const result = await read(world, { options })
    const perCall = (options as any).perCallTimeoutMs ?? 5000
    const deadline = (options as any).deadlineMs ?? 15000
    assert.ok(world.calls.length >= 4)
    for (const call of world.calls) {
      const expected = Math.min(perCall, Math.floor((start + deadline - call.atMs - 500) / 2))
      assert.equal(call.options.timeout, expected, `call ${call.n} (${call.method}) at +${call.atMs - start} ms`)
      assert.ok(call.options.timeout >= 1 && Number.isInteger(call.options.timeout))
    }
    assert.equal(result.reading.counts.calls, world.calls.length)
  }
})

test('G8d with a deadline too short for the work: the calls that fit are made, the others are not, and nothing starts when less than the margin is left', async () => {
  const world = W({ latencyMs: 150 })
  for (let index = 1; index <= 10; index++) world.addRefund({ id: `re_${index}`, amount: index, status: 'succeeded' })
  const start = world.clock.now()
  const result = await read(world, { options: { deadlineMs: 1000 } })
  for (const call of world.calls) assert.ok(call.atMs <= start + 1000 - 502, `call ${call.n} started with ${start + 1000 - call.atMs} ms left`)
  assert.ok(world.calls.length <= 12, `${world.calls.length} calls`)
  assert.ok(result.reading.failures.some((entry) => entry.kind === 'budget'), 'the budget stopped the reading')
  const asText = result.reading.failures.map((entry) => JSON.stringify(entry))
  assert.equal(new Set(asText).size, asText.length, 'a failure is reported once, however many calls it stopped')
  assertFailClosed(result, 'G8d')
})

test('G11 B: a client that IGNORES the timeouts (answers after 30 s whatever it was asked) makes the call end late and nothing more is started; the report says it was not within the deadline - there is no promise of 15 seconds', async () => {
  const world = W({ latencyMs: 30000 })
  world.honorTimeout = false
  const start = world.clock.now()
  const result = await read(world)
  assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'])
  assert.equal(result.reading.temporal.withinDeadline, false)
  assert.equal(result.reading.temporal.spanMs, 30000)
  assert.equal(result.reading.temporal.finishedAtMs, start + 30000)
  assert.deepEqual(reasonsOf(result), ['budget_exhausted'])
  assertFailClosed(result, 'G11')
})

test('G12 B: a promise that NEVER settles is not rescued by the reader (no timer, no race): the reading stays pending and no other call is made - the absolute ceiling belongs to the caller', async () => {
  const world = W()
  world.fault('paymentIntents.retrieve', 1, fail.never())
  const reading = read(world)
  const outcome = await Promise.race([reading.then(() => 'settled'), new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 80))])
  assert.equal(outcome, 'still pending')
  assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'])
  const late = W()
  late.fault('refunds.list', 1, fail.never())
  const second = read(late)
  assert.equal(await Promise.race([second.then(() => 'settled'), new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 80))]), 'still pending')
  assert.deepEqual(methodsOf(late), ['paymentIntents.retrieve', 'refunds.list'])
})

test('G13 the clock: it is read before every call and at the end; a reading that is not a number ends the calls (budget, clock); a clock that goes BACK is held at its highest; the times of the report never go back', async () => {
  const world = W()
  let reads = 0
  const flaky = () => (++reads <= 3 ? world.clock.now() : Number.NaN)
  const stopped = await read(world, { options: { now: flaky } })
  assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve', 'refunds.list'])
  assert.ok(stopped.reading.failures.some((entry) => entry.kind === 'budget' && entry.ref === 'clock'))
  assert.deepEqual(reasonsOf(stopped), ['budget_exhausted'])
  assertFailClosed(stopped, 'G13 NaN')
  const thrower = W()
  let count = 0
  const result = await read(thrower, { options: { now: () => { if (++count > 2) throw new Error(CANARIES.errorText); return thrower.clock.now() } } })
  assert.ok(result.reading.failures.some((entry) => entry.kind === 'budget' && entry.ref === 'clock'))
  assertNoCanary(result, 'G13 throw')
  const back = W()
  const base = back.clock.now()
  let step = 0
  const timeline = [base, base + 100, base - 50000, base - 50000, base + 200, base + 300, base + 400, base + 500, base + 600]
  const going = await read(back, { options: { now: () => timeline[Math.min(step++, timeline.length - 1)] } })
  const { startedAtMs, finishedAtMs, spanMs } = going.reading.temporal
  assert.ok((startedAtMs as number) <= (finishedAtMs as number))
  assert.equal(spanMs, (finishedAtMs as number) - (startedAtMs as number))
  assert.ok(back.calls.every((call) => call.options.timeout >= 1 && call.options.timeout <= 5000))
})

test('G13b a clock that goes BACK is held at its highest reading: the times never go back and the timeouts follow the highest reading; and a reading that is not a number ends the calls for good, even if the clock recovers', async () => {
  const back = W()
  const base = back.clock.now()
  let reads = 0
  const result = await read(back, { options: { now: () => { reads++; return reads === 1 ? base : reads === 2 ? base + 10000 : base + 5 } } })
  assert.equal(result.reading.temporal.startedAtMs, base)
  assert.equal(result.reading.temporal.finishedAtMs, base + 10000, 'held at the highest reading')
  assert.equal(result.reading.temporal.spanMs, 10000)
  assert.equal(back.calls[1].options.timeout, Math.min(5000, Math.floor((15000 - 10000 - 500) / 2)), 'the later calls are timed from the highest reading')
  const flickers = W()
  flickers.addRefund({ id: 're_a', amount: 5, status: 'succeeded' })
  flickers.addRefund({ id: 're_b', amount: 6, status: 'succeeded' })
  let count = 0
  const stopped = await read(flickers, { options: { now: () => (++count === 4 ? Number.NaN : flickers.clock.now()) } })
  assert.deepEqual(methodsOf(flickers), ['paymentIntents.retrieve', 'refunds.list'], 'after one reading that is not a number nothing more is called - not the disputes, not the movements, although the clock is fine again')
  assert.equal(stopped.reading.counts.unresolvedMovements, 2)
  assert.deepEqual(reasonsOf(stopped), ['budget_exhausted', 'movements_unresolved'])
  assertFailClosed(stopped, 'G13b')
})

test('G16 a budget that runs out BETWEEN two pages of a list leaves that list incomplete and cut (what was read is kept), and says both the budget and the cut', async () => {
  const world = refundsWorld(5)
  world.latencyMs = 300
  world.honorTimeout = false
  const result = await read(world, { options: { pageSize: 2, deadlineMs: 1000 } })
  assert.equal(world.callsOf('refunds.list').length, 1)
  assert.deepEqual(ids(result.evidence.refunds), ['re_5', 're_4'])
  assert.equal(result.reading.structure.parts.refunds, 'incomplete')
  assert.deepEqual(reasonsOf(result), ['budget_exhausted', 'refunds_truncated'])
  assert.deepEqual(result.reading.failures, [{ call: 'refunds.list', kind: 'budget', page: 2, ref: 'deadline' }, { call: 'disputes.list', kind: 'budget', page: 1, ref: 'deadline' }])
  assert.equal(result.evidence.disputes, null)
  assertFailClosed(result, 'G16')
})

test('G3 the disputes that could not be read are NOT READ (null, its own reason), and the refunds are still read', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'pending' })
  world.fault('disputes.list', 1, fail.sdk(sdkErrors.permission))
  const result = await read(world)
  assert.equal(result.evidence.disputes, null)
  assert.deepEqual(ids(result.evidence.refunds), ['re_a'])
  assert.deepEqual(reasonsOf(result), ['disputes_not_read'])
  assert.equal(result.reading.structure.parts.disputes, 'not_read')
  assert.deepEqual(result.reading.failures, [{ call: 'disputes.list', page: 1, kind: 'permission', statusCode: 403 }])
  assertFailClosed(result, 'G3')
})

const CHAOS: Array<(world: World, random: () => number, seed: number) => void> = [
  (world) => { world.fault('refunds.list', undefined, () => ok({ object: 'list', has_more: true, data: [{ id: 're_loop', object: 'refund' }] })) },   // the same page forever
  (world, _random, seed) => { let page = 0; world.fault('disputes.list', undefined, () => ok({ object: 'list', has_more: true, data: [{ id: `dp_inf_${seed}_${page++}`, object: 'dispute', livemode: world.livemode }] })) },   // always more, always new
  (world) => { world.fault('refunds.list', undefined, fail.transform((page) => { page.data = [...page.data, ...page.data, ...page.data, ...page.data]; return page })) },   // too many for the limit
  (world) => { world.fault('refunds.list', 1, () => ok({ object: 'list', has_more: false, get data(): unknown { throw new Error(CANARIES.errorText) } })) },   // a getter that throws
  (world) => { world.latencyMs = 100000; world.honorTimeout = false },   // answers that take 100 s whatever is asked
  (world, random) => { world.fault('balanceTransactions.retrieve', undefined, fail.transform((bt) => ({ ...bt, id: random() < 0.5 ? 'txn_other' : bt.id }))) },
  (world) => { world.fault('paymentIntents.retrieve', 2, fail.sdk(sdkErrors.api)) },
]
test('G10 TERMINATION under adversaries (fixed seeds): cycles, endless "more", oversize pages, getters that throw, answers that take 100 s - the reading ends, never rejects, stays within the number of calls, starts nothing when the budget is gone, and is deterministic', async () => {
  const MAX_CALLS = 32
  for (let seed = 1; seed <= Math.min(WORLDS, 400); seed++) {
    const build = () => {
      const world = randomWorld(seed)
      const random = mulberry32(seed * 7919)
      const picks = new Set<number>()
      for (let count = between(random, 1, 3); count > 0; count--) picks.add(Math.floor(random() * CHAOS.length))
      for (const index of picks) CHAOS[index](world, mulberry32(seed + index), seed)
      return world
    }
    const world = build()
    const start = world.clock.now()
    const result = await read(world)
    assert.ok(world.calls.length <= MAX_CALLS, `seed ${seed}: ${world.calls.length} calls`)
    assert.equal(result.reading.counts.calls, world.calls.length, `seed ${seed}`)
    for (const call of world.calls) assert.ok(call.atMs <= start + 15000 - 502, `seed ${seed}: call ${call.n} started with the budget gone`)
    assertFailClosed(result, `seed ${seed}`)
    assertNoCanary(result, `seed ${seed}`)
    const again = await read(build())
    assert.equal(JSON.stringify(again), JSON.stringify(result), `seed ${seed}: the same world, read twice, gives the same report`)
    if (result.reading.temporal.finishedAtMs !== null && result.reading.temporal.startedAtMs !== null) {
      assert.equal(result.reading.temporal.withinDeadline, (result.reading.temporal.finishedAtMs as number) - (result.reading.temporal.startedAtMs as number) <= 15000, `seed ${seed}`)
    }
  }
})

const FAULT_MENU: Array<(world: World, random: () => number) => void> = [
  (world) => { world.fault('refunds.list', 1, fail.sdk(sdkErrors.rateLimit)) },
  (world) => { world.fault('refunds.list', 2, fail.sdk(sdkErrors.api)) },
  (world) => { world.fault('disputes.list', 1, fail.sdk(sdkErrors.permission)) },
  (world) => { world.fault('disputes.list', 1, fail.resolve({ object: 'list' })) },
  (world) => { world.fault('refunds.list', 1, fail.transform((page) => { page.has_more = 'nope'; return page })) },
  (world) => { world.fault('balanceTransactions.retrieve', undefined, fail.sdk(() => sdkErrors.timeout())) },
  (world) => { world.fault('balanceTransactions.retrieve', 1, fail.resolve('txn')) },
  (world) => { world.fault('paymentIntents.retrieve', 2, fail.sdk(sdkErrors.connection)) },
  (world) => { world.ignoreExpand = true },
  (world) => { world.chargeOverride = { ...world.chargeOverride, disputed: undefined } },
  (world) => { world.chargeOverride = { ...world.chargeOverride, amount_refunded: undefined } },
  (world) => { world.inlineDisputeBts = false },
]
test('G9 no error ever becomes an empty list (fixed seeds, random faults on random worlds): a list that could not be read is null, a list that was cut is has_more true; the report never rejects and holds no text of the error', async () => {
  for (let seed = 1; seed <= WORLDS; seed++) {
    const world = randomWorld(seed)
    const random = mulberry32(seed * 104729)
    for (let count = between(random, 1, 3); count > 0; count--) pick(random, FAULT_MENU)(world, random)
    const result = await read(world)
    assertFailClosed(result, `seed ${seed}`)
    assertNoCanary(result, `seed ${seed}`)
    const listFailures = new Set(result.reading.failures.filter((entry) => entry.call === 'refunds.list' || entry.call === 'disputes.list').map((entry) => entry.call))
    if (listFailures.has('refunds.list')) assert.ok(result.evidence.refunds === null || result.evidence.refunds.has_more === true, `seed ${seed}: refunds`)
    if (listFailures.has('disputes.list')) assert.ok(result.evidence.disputes === null || result.evidence.disputes.has_more === true, `seed ${seed}: disputes`)
    const p = await position(result.evidence)
    assert.ok(p && typeof p.certainty === 'string', `seed ${seed}: the funds model answers`)
  }
})

// =====================================================================================================================================================================
// H. What the reading can SEE of a world that changes while it is read - and what it cannot. A reading is a composition of observations, not a snapshot.
// =====================================================================================================================================================================
test('H1 a world that stays still: four calls, the closing read equals the first on the fields the model reads (and a change of a field it does NOT read is no change), the evidence is the closing read\'s', async () => {
  const world = W()
  world.at('T3', (w) => { w.piOverride = { description: 'another description', receipt_email: 'someone.else@example.invalid' }; w.chargeOverride = { receipt_url: 'https://pay.example.invalid/other' } }, 'fields nobody reads change')
  const result = await read(world)
  assert.deepEqual(methodsOf(world), DEFAULT_SEQUENCE)
  assert.equal(result.reading.temporal.paymentIntentRecheck, 'same')
  assert.equal(result.reading.temporal.observation, 'no_change_observed')
  assert.deepEqual(result.reading.temporal.signals, [])
  const changing = W()
  changing.at('T3', (w) => w.addRefund({ id: 're_new', amount: 20, status: 'pending' }))
  const second = await read(changing)
  assert.equal(second.evidence.charge?.amount_refunded, 20, 'the evidence of the payment and of the charge is the CLOSING read\'s (the most recent)')
  assert.equal(second.reading.temporal.paymentIntentRecheck, 'different')
})

async function judged(world: World, event: EventId | null, time: 'T0' | 'T1' | 'T2' | 'T3' | 'T4') {
  const result = await read(world)
  if (event && time === 'T4') world.apply((w) => applyEvent(w, event), `${event} after the reading`)
  return { result, shown: await position(result.evidence), reality: await position(world.oracleRaw()) }
}
test('H2 scenario 1 - a refund that succeeded FAILS while the reading goes on: seen by the closing read at T1, T2 and T3 (degraded, uncertain); a coherent world at T0 (100, proven, final); at T4 nobody can see it (80 proven, not final: an estimate by defect, pinned)', async () => {
  for (const time of ['T1', 'T2', 'T3'] as const) {
    const { result, shown } = await judged(caseWorld('X3', 'B-b', time), 'X3', time)
    assert.equal(result.reading.temporal.paymentIntentRecheck, 'different', time)
    assert.equal(result.reading.temporal.observation, 'change_observed', time)
    assertFailClosed(result, time)
    assert.equal(shown.certainty, 'uncertain', time)
  }
  const before = await judged(caseWorld('X3', 'B-b', 'T0'), 'X3', 'T0')
  assert.deepEqual([before.result.reading.temporal.observation, before.shown.certainty, before.shown.retainedLowerCents, before.shown.final], ['no_change_observed', 'proven', 100, true])
  const after = await judged(caseWorld('X3', 'B-b', 'T4'), 'X3', 'T4')
  assert.equal(after.result.reading.temporal.observation, 'no_change_observed', 'a change after the last read is invisible by definition')
  assert.deepEqual([after.shown.certainty, after.shown.final, after.shown.retainedLowerCents, after.shown.retainedUpperCents], ['proven', false, 80, 80])
  assert.deepEqual([after.reality.certainty, after.reality.retainedLowerCents], ['proven', 100])
  const total = await judged(caseWorld('X3', 'B-c', 'T4'), 'X3', 'T4')
  const { retainedIsZero } = await loadP1()
  assert.equal(retainedIsZero(total.shown), 'unknown', 'a total refund is zero in the snapshot only: never "nothing is held"')
})

test('H3 scenario 2 - ABA: a refund fails and a new one of the SAME amount is made. If the lists were read before and the closing read follows, nothing differs: "no change observed", 80 proven - while reality is 80..100 uncertain. PINNED as a known limit, with the report saying what it did not verify', async () => {
  const { result, shown, reality } = await judged(caseWorld('X4', 'B-b', 'T3'), 'X4', 'T3')
  assert.equal(result.reading.temporal.paymentIntentRecheck, 'same')
  assert.equal(result.reading.temporal.observation, 'no_change_observed')
  assert.deepEqual([shown.certainty, shown.retainedLowerCents, shown.retainedUpperCents, shown.final], ['proven', 80, 80, false])
  assert.deepEqual([reality.certainty, reality.retainedLowerCents, reality.retainedUpperCents], ['uncertain', 80, 100])
  for (const code of ['aba_between_open_and_close', 'new_entries_after_list_read', 'atomicity_across_objects', 'changes_between_calls', 'changes_after_close']) assert.ok(result.reading.temporal.notVerified.includes(code as any), code)
  // the same event before the lists are read is only conservative: the new refund is pending, so the model sees it
  const early = await judged(caseWorld('X4', 'B-b', 'T1'), 'X4', 'T1')
  assert.equal(early.shown.certainty, 'uncertain')
})

test('H4 scenario 3 - a dispute changes while the flag of the charge does not: nothing on the payment can show it. Open -> lost seen late is only conservative; a SECOND dispute born after the list was read, with the flag already true, is not seen at all (the principal known limit, pinned)', async () => {
  const late = await judged(caseWorld('X6', 'B-e', 'T3'), 'X6', 'T3')
  assert.equal(late.result.reading.temporal.observation, 'no_change_observed')
  assert.equal(late.shown.certainty, 'uncertain', 'still open in the evidence: nothing promoted')
  const second = await judged(caseWorld('X8', 'B-f', 'T3'), 'X8', 'T3')
  assert.equal(second.result.reading.temporal.observation, 'no_change_observed', 'the flag was already true')
  assert.deepEqual([second.shown.certainty, second.shown.retainedLowerCents], ['proven', 100])
  assert.equal(second.reality.certainty, 'uncertain')
  assert.ok(second.result.reading.temporal.notVerified.includes('dispute_changes_without_flag_change'))
  const first = await judged(caseWorld('X5', 'B-a', 'T3'), 'X5', 'T3')
  assert.equal(first.result.reading.temporal.paymentIntentRecheck, 'different', 'the FIRST dispute turns the flag: the closing read sees it')
  assertFailClosed(first.result, 'X5')
})

test('H5 scenario 4 - a refund born WHILE the list is walked page by page sits before the cursor and is never shown; the closing read sees the aggregate move and degrades the lists; a refund that waits for an action is seen only if Stripe counts it in the aggregate (both variants played, neither observed on the real Stripe)', async () => {
  const world = refundsWorld(5)
  world.at({ method: 'refunds.list', nth: 2 }, (w) => w.addRefund({ id: 're_late', amount: 9, status: 'pending' }), 'a refund appears between the pages')
  const result = await read(world, { options: { pageSize: 2 } })
  assert.ok(!ids(result.evidence.refunds).includes('re_late'))
  assert.equal(new Set(ids(result.evidence.refunds)).size, ids(result.evidence.refunds).length, 'nothing is repeated or skipped by the walk')
  assert.equal(result.reading.temporal.paymentIntentRecheck, 'different')
  assertFailClosed(result, 'H5')
  const unseen = await judged(caseWorld('X9', 'B-a', 'T2', { countsRequiresAction: false }), 'X9', 'T2')
  assert.equal(unseen.result.reading.temporal.observation, 'no_change_observed', 'the aggregate does not move: nothing shows it')
  assert.equal(unseen.shown.certainty, 'proven')
  assert.equal(unseen.reality.certainty, 'uncertain')
  const seen = await judged(caseWorld('X9', 'B-a', 'T2', { countsRequiresAction: true }), 'X9', 'T2')
  assert.equal(seen.result.reading.temporal.paymentIntentRecheck, 'different')
  assertFailClosed(seen.result, 'X9 counted')
})

test('H5b the order moves under the walk: a refund that becomes newer than the cursor is skipped without a sound - the walk looks regular, but the aggregate (read twice) and the funds model (listed vs reported) still object; the reader itself does not see it (pinned)', async () => {
  const world = refundsWorld(5)
  world.at({ method: 'refunds.list', nth: 2 }, (w) => { w.find('refunds', 're_3').created = 9_000_000_000 }, 're_3 becomes the newest')
  const result = await read(world, { options: { pageSize: 2 } })
  assert.ok(!ids(result.evidence.refunds).includes('re_3'), 'it was skipped')
  assert.equal(result.reading.temporal.pagination, 'regular')
  assert.equal(result.reading.temporal.observation, 'no_change_observed')
  const p = await position(result.evidence)
  assert.ok(codes(p).includes('uncertainty:refunded_amount_unexplained'), 'the funds model sees the gap between the list and the aggregate')
})

test('H6 a change AFTER the closing read is invisible to that reading and visible to the next; H8 readings keep no memory of each other', async () => {
  const world = W()
  const first = await read(world)
  world.apply((w) => w.addRefund({ id: 're_after', amount: 20, status: 'pending' }), 'a refund after the reading')
  assert.deepEqual(ids(first.evidence.refunds), [])
  const second = await read(world)
  assert.deepEqual(ids(second.evidence.refunds), ['re_after'])
  assert.equal(second.reading.temporal.paymentIntentRecheck, 'same')
})

test('H7 two readings at the same time share nothing: each gives exactly what it gives alone', async () => {
  const a = () => { const world = W({ pi: 'pi_a', charge: 'ch_a' }); world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' }); return world }
  const b = () => { const world = W({ pi: 'pi_b', charge: 'ch_b', livemode: true }); world.addDispute({ id: 'dp_b', amount: 100, status: 'won' }); return world }
  const [aloneA, aloneB] = [await read(a()), await read(b())]
  const [togetherA, togetherB] = await Promise.all([read(a()), read(b())])
  assert.equal(JSON.stringify(togetherA), JSON.stringify(aloneA))
  assert.equal(JSON.stringify(togetherB), JSON.stringify(aloneB))
  assert.deepEqual(ids(togetherA.evidence.refunds), ['re_a'])
  assert.deepEqual(ids(togetherB.evidence.disputes), ['dp_b'])
})

test('H9 the same world read twice gives the same report, key by key and in the same order', async () => {
  const build = () => { const world = randomWorld(77); world.at('T3', (w) => w.addRefund({ id: 're_x', amount: 1, status: 'pending' })); return world }
  assert.equal(JSON.stringify(await read(build())), JSON.stringify(await read(build())))
})

test('H11 the times: the start is never after the end, the span is their difference, the deadline is judged on the injected clock', async () => {
  const world = W({ latencyMs: 250 })
  const start = world.clock.now()
  const { reading } = await read(world)
  assert.deepEqual([reading.temporal.startedAtMs, reading.temporal.finishedAtMs, reading.temporal.spanMs, reading.temporal.withinDeadline], [start, start + 1000, 1000, true])
  const slow = W({ latencyMs: 2400 })
  const late = await read(slow, { options: { deadlineMs: 5000 } })
  assert.ok((late.reading.temporal.finishedAtMs as number) - (late.reading.temporal.startedAtMs as number) >= 0)
})

test('H12 the list of what NOBODY verifies is the same frozen list - the very same array - in every report, even one that made no call', async () => {
  const { FUNDS_READ_NOT_VERIFIED } = await load()
  const world = W()
  const reports = [
    await read(world),
    await read(W(), { request: { paymentIntentId: 'x' } }),
    await read(Object.assign(W(), { piOverride: { livemode: 'maybe' } })),
    await read((() => { const degraded = W(); degraded.at('T3', (w) => w.addRefund({ id: 're_z', amount: 1, status: 'pending' })); return degraded })()),
    await read((() => { const hung = W(); hung.fault('paymentIntents.retrieve', undefined, fail.sdk(sdkErrors.api)); return hung })()),
  ]
  for (const report of reports) assert.equal(report.reading.temporal.notVerified, FUNDS_READ_NOT_VERIFIED)
  assert.deepEqual([...FUNDS_READ_NOT_VERIFIED], [
    'atomicity_across_objects', 'changes_between_calls', 'aba_between_open_and_close', 'new_entries_after_list_read', 'dispute_changes_without_flag_change', 'changes_after_close',
    'list_order_and_cursor_stability', 'mode_of_refunds_and_movements', 'finality',
  ])
  assert.ok(Object.isFrozen(FUNDS_READ_NOT_VERIFIED))
  assert.throws(() => (FUNDS_READ_NOT_VERIFIED as unknown as string[]).push('x'), TypeError)
})

// ---- H13: the matrix of events and moments. THE KNOWN LIMITS ARE AN ALLOWED SET, NOT A QUOTA: a case that gets better is verified and reported; a case that gets WORSE (a favourable promotion that is not in the set) fails the test and
// ---- is documented as a regression or a risk - the set is never lengthened to make it pass. The 23 below are the ones the simulation of the plan (R2.1) found; that number is a result of that simulation, not a law.
const TIMES = ['T0', 'T1', 'T2', 'T3', 'T4'] as const
const KNOWN_LIMITS = new Set<string>([
  // after the last read (nothing could be seen)
  'X1|B-a|T4', 'X1|B-b|T4', 'X1|B-f|T4', 'X5|B-a|T4', 'X5|B-b|T4', 'X5|B-c|T4', 'X4|B-b|T4', 'X4|B-c|T4', 'X8|B-f|T4', 'X9|B-a|T4', 'X9|B-b|T4', 'X9|B-f|T4',
  // inside the reading (the aggregate and the flag do not move, or move back)
  'X4|B-b|T2', 'X4|B-b|T3', 'X4|B-c|T2', 'X4|B-c|T3', 'X9|B-a|T2', 'X9|B-a|T3', 'X9|B-b|T2', 'X9|B-b|T3', 'X9|B-f|T2', 'X9|B-f|T3', 'X8|B-f|T3',
])
// FOUND BY THIS IMPLEMENTATION'S MATRIX, NOT BY THE PLAN'S: the same events on a base the plan's simulation did not pair them with - B-d, a refund that is already pending, so the position is ALREADY uncertain. The
// classes are the same (a new refund or a first dispute after the last read; a refund that waits for an action and moves nothing) and so is the reason (the aggregate and the flag do not show it, or it came after the
// last read); what is promoted is only the LOWER bound of a position that stays uncertain (80 where reality says 60). They are listed apart, one by one, and the test below pins that they are of this kind only.
const ADDITIONAL_INSTANCES = new Set<string>(['X1|B-d|T4', 'X5|B-d|T4', 'X9|B-d|T2', 'X9|B-d|T3', 'X9|B-d|T4'])
// is what the reading shows MORE FAVOURABLE than what the world is at the end: proven where reality is not, a higher lower bound, or "nothing is held" where it is not
async function moreFavourable(shown: FundsPosition, reality: FundsPosition): Promise<boolean> {
  const { retainedIsZero } = await loadP1()
  return (shown.certainty === 'proven' && reality.certainty !== 'proven') || shown.retainedLowerCents > reality.retainedLowerCents || (retainedIsZero(shown) === 'yes' && retainedIsZero(reality) !== 'yes')
}
function expectedRecheck(world: World): 'same' | 'different' | 'not_done' {
  const opened = world.returned.filter((entry) => entry.method === 'paymentIntents.retrieve')
  if (opened.length < 2) return 'not_done'
  const view = (response: any) => JSON.stringify([expectedProjection('paymentIntent', response), response.latest_charge && typeof response.latest_charge === 'object' ? expectedProjection('charge', response.latest_charge) : response.latest_charge])
  return view(opened[0].response) === view(opened[1].response) ? 'same' : 'different'
}
test('H13 the matrix of events and moments (every event on every base it can happen to, at every moment, with and without Stripe counting a refund that waits for an action): the closing read says "different" EXACTLY when the fields the model reads differ; "nothing is held" is never promoted; every favourable promotion is a KNOWN limit of the plan or a listed additional instance - anything else fails', async (t) => {
  const { retainedIsZero } = await loadP1()
  for (const counted of [false, true]) {
    // when Stripe counts a refund that waits for an action in the aggregate, the closing read SEES one more of the cases: the allowed sets are then smaller, never larger
    const inside = (key: string) => counted && /^X9\|.*\|T[23]$/.test(key)
    const known = new Set([...KNOWN_LIMITS].filter((key) => !inside(key)))
    const additional = new Set([...ADDITIONAL_INSTANCES].filter((key) => !inside(key)))
    const promoted: string[] = []
    const improved: string[] = []
    let cases = 0
    for (const [event, base] of PAIRS) {
      for (const time of TIMES) {
        cases++
        const key = `${event}|${base}|${time}`
        const world = caseWorld(event, base, time, { countsRequiresAction: counted })
        const { result, shown, reality } = await judged(world, event, time)
        const label = `${key} (requires_action ${counted ? '' : 'not '}counted)`
        // the rule of the closing read, checked on what the fake RETURNED and not on what the reader says
        assert.equal(result.reading.temporal.paymentIntentRecheck, expectedRecheck(world), label)
        assertFailClosed(result, label)
        assert.ok(!(retainedIsZero(shown) === 'yes' && retainedIsZero(reality) !== 'yes'), `${label}: "nothing is held" was promoted`)
        if (await moreFavourable(shown, reality)) {
          promoted.push(key)
          // an additional instance is the LOWER bound of a position that stays uncertain - never a position that turns "proven"
          if (additional.has(key)) assert.equal(shown.certainty, 'uncertain', `${label}: an additional instance must not be a proven position`)
        } else if (known.has(key)) improved.push(key)
      }
    }
    const tag = `requires_action ${counted ? '' : 'not '}counted`
    t.diagnostic(`H13 (${tag}): ${cases} cases; favourable and unseen: ${promoted.length} [${promoted.join(', ')}]`)
    t.diagnostic(`H13 (${tag}): of the plan's known limits, those that did NOT promote here (verify and document): ${improved.length} [${improved.join(', ')}]`)
    assert.deepEqual(promoted.filter((key) => !known.has(key) && !additional.has(key)), [], 'a favourable promotion outside the known limits and the listed additional instances: a regression or a new risk - document it, do not add it to a set to make this pass')
  }
})

// =====================================================================================================================================================================
// I. The projection: the fields the funds model reads, as they came - nothing repaired, nothing added up, nothing personal
// =====================================================================================================================================================================
function assertOnlyTheReadSet(evidence: Rec, label: string) {
  const only = (value: unknown, allowed: readonly string[], what: string) => {
    if (value === null || typeof value !== 'object') return
    for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `${label}: ${what} carries "${key}"`)
  }
  only(evidence.paymentIntent, EXPECTED_FIELDS.paymentIntent, 'the payment')
  only(evidence.charge, EXPECTED_FIELDS.charge, 'the charge')
  for (const refund of evidence.refunds?.data ?? []) {
    only(refund, EXPECTED_FIELDS.refund, 'a refund')
    for (const slot of ['balance_transaction', 'failure_balance_transaction']) only(refund?.[slot], EXPECTED_FIELDS.transaction, `the ${slot} of a refund`)
  }
  for (const dispute of evidence.disputes?.data ?? []) {
    only(dispute, EXPECTED_FIELDS.dispute, 'a dispute')
    for (const movement of Array.isArray(dispute?.balance_transactions) ? dispute.balance_transactions : []) only(movement, EXPECTED_FIELDS.transaction, 'a movement of a dispute')
  }
}
test('I2 FIDELITY (fixed seeds, still worlds): the evidence is EXACTLY the projection of what the world says, the reading is complete and clean, and the funds model gives the same answer on it as on the whole raw reading - finding by finding', async () => {
  for (let seed = 1; seed <= WORLDS; seed++) {
    const world = randomWorld(seed)
    const result = await read(world)
    assert.equal(result.reading.structure.complete, true, `seed ${seed}: ${JSON.stringify(result.reading.structure.incomplete)}`)
    assert.equal(result.reading.temporal.observation, 'no_change_observed', `seed ${seed}`)
    const raw = world.oracleRaw()
    assert.deepEqual(result.evidence, expectedFromOracle(raw), `seed ${seed}`)
    assert.deepEqual(await position(result.evidence), await position(raw), `seed ${seed}`)
    assertOnlyTheReadSet(result.evidence as Rec, `seed ${seed}`)
    assertNoCanary(result, `seed ${seed}`)
    assert.deepEqual(world.mutationAttempts, [], `seed ${seed}`)
  }
})

test('I2b DIRTY WORLDS (fixed seeds): in about one world in eight one field the model reads holds a value that is not what Stripe sends (text for a number, a fraction, null, NaN, infinity, a number beyond the safe integers, or nothing at all) - the evidence still equals the projection of the world, field by field, and the model says the same of it as of the raw world', async () => {
  let dirty = 0
  for (let seed = 1; seed <= Math.max(400, Math.floor(WORLDS / 2)); seed++) {
    const clean = randomWorld(seed, { dirty: false })
    const world = randomWorld(seed)
    if (JSON.stringify(world.oracleRaw()) === JSON.stringify(clean.oracleRaw())) continue
    dirty++
    const result = await read(world)
    assert.equal(result.reading.structure.complete, true, `seed ${seed}`)
    assert.deepEqual(result.evidence, expectedFromOracle(world.oracleRaw()), `seed ${seed}`)
    assert.deepEqual(await position(result.evidence), await position(world.oracleRaw()), `seed ${seed}`)
  }
  assert.ok(dirty >= 20, `only ${dirty} dirty worlds were drawn`)
})

test('I3 nothing is repaired: strings where numbers belong, upper-case currencies, odd statuses, malformed ids, a flag that is a string, a fraction - all come out exactly as they went in, and the funds model judges them as it would the raw ones', async () => {
  const world = W()
  world.addRefund({ id: 're_d1', amount: 20, status: 'succeeded', over: { amount: '20', currency: 'EUR', status: '  Succeeded ', charge: 'ch t1', balance_transaction: null, failure_balance_transaction: null } })
  world.addRefund({ id: 're d2', amount: 5, status: 'pending', over: { amount: 5.5, payment_intent: { id: 'pi_t1', object: 'payment_intent', client_secret: CANARIES.clientSecret, receipt_email: CANARIES.email } } })
  world.addDispute({ id: 'dp_d', amount: 100, status: 'lost', over: { amount: -5, currency: 'eu', status: 'LOST' } })
  world.chargeOverride = { amount_captured: 1.5, amount_refunded: '0', disputed: 'false', currency: 42 }
  world.piOverride = { amount_received: '100', status: 5 }
  const result = await read(world)
  assert.equal(result.reading.structure.complete, true)
  assert.deepEqual(result.evidence, expectedFromOracle(world.oracleRaw()))
  assert.equal(result.evidence.refunds?.data[1].amount, '20')
  assert.equal(result.evidence.refunds?.data[1].currency, 'EUR')
  assert.equal(result.evidence.refunds?.data[1].status, '  Succeeded ')
  assert.deepEqual(result.evidence.refunds?.data[0].payment_intent, { id: 'pi_t1' }, 'an expanded reference is read by its id, nothing else of it survives')
  assert.equal(result.evidence.charge?.disputed, 'false')
  assert.equal(result.evidence.paymentIntent?.status, 5)
  assert.deepEqual(await position(result.evidence), await position(world.oracleRaw()))
  assertNoCanary(result, 'I3')
})

test('I4 references: an expanded object is cut to its id (and to {} when it has none), a string stays a string, something that is not a reference stays what it is - and a value that is not a scalar where a scalar belongs never carries its contents along', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'pending', over: { payment_intent: { object: 'payment_intent' }, charge: 5 } })
  world.addRefund({ id: 're_b', amount: 20, status: 'pending', over: { payment_intent: ['pi_t1'], charge: null } })
  world.addRefund({ id: 're_o', amount: 20, status: 'pending', over: { currency: { client_secret: CANARIES.clientSecret }, amount: [1, 2], status: { x: CANARIES.email }, charge: { id: { client_secret: CANARIES.clientSecret } } } })
  const result = await read(world)
  const byId = (id: string) => (result.evidence.refunds?.data as Rec[]).find((entry) => entry.id === id) as Rec
  assert.deepEqual(byId('re_a').payment_intent, {})
  assert.equal(byId('re_a').charge, 5)
  assert.equal(byId('re_b').charge, null)
  assert.ok(typeof byId('re_b').payment_intent === 'string' && !/^[A-Za-z0-9_]+$/.test(byId('re_b').payment_intent), 'an array where a reference belongs is a value no id can be')
  assert.ok(typeof byId('re_o').charge.id === 'string' && !/^[A-Za-z0-9_]+$/.test(byId('re_o').charge.id), 'a non-scalar inside a reference does not travel either')
  for (const slot of ['currency', 'amount', 'status']) assert.ok(typeof byId('re_o')[slot] === 'string' && !/^[A-Za-z0-9_]+$/.test(byId('re_o')[slot]) && byId('re_o')[slot] !== CANARIES.clientSecret, `the ${slot}`)
  assertNoCanary(result, 'I4')
  assert.notEqual((await position(result.evidence)).certainty, 'proven')
})

test('I5 nothing it is given is touched: frozen request, options and requested refunds are read without a word; the responses (read-only views) record no attempt to write; the result is the same as for unfrozen input', async () => {
  const build = () => { const world = randomWorld(31); world.addRefund({ id: 're_z', amount: 3, status: 'pending' }); return world }
  const world = build()
  const requested = Object.freeze([Object.freeze({ id: 're_q', amount: 5 })])
  const request = Object.freeze({ paymentIntentId: world.piId, expectedLivemode: world.livemode, requestedRefunds: requested })
  const options = Object.freeze({ now: world.clock.now, pageSize: 2 })
  const frozen = await readRaw(world.client(), request, options)
  assert.deepEqual(world.mutationAttempts, [])
  const plain = build()
  const loose = await read(plain, { request: { requestedRefunds: [{ id: 're_q', amount: 5 }] }, options: { pageSize: 2 } })
  assert.equal(JSON.stringify(frozen), JSON.stringify(loose))
  // a frozen array of frozen objects is read and COPIED into a plain array of plain objects of the reader's own
  assert.deepStrictEqual(frozen.evidence.requestedRefunds, [{ id: 're_q', amount: 5 }])
  assert.notStrictEqual(frozen.evidence.requestedRefunds, requested)
  assert.ok(!Object.isFrozen(frozen.evidence.requestedRefunds) && !Object.isFrozen(frozen.evidence.requestedRefunds?.[0]))
})

test('I6 each movement lands in ITS slot, and only there: a balance transaction read for one refund is never put in another refund, nor in the other slot of the same one', async () => {
  const world = W()
  world.addRefund({ id: 're_1', amount: 10, status: 'succeeded' })
  world.addRefund({ id: 're_2', amount: 20, status: 'failed' })
  world.addRefund({ id: 're_3', amount: 30, status: 'pending' })
  world.addRefund({ id: 're_4', amount: 40, status: 'succeeded' })
  const refunds = (await read(world)).evidence.refunds?.data as Rec[]
  assert.deepEqual(refunds.map((refund) => [refund.id, refund.balance_transaction?.id ?? null, refund.balance_transaction?.source ?? null, refund.failure_balance_transaction?.id ?? null, refund.failure_balance_transaction?.source ?? null]), [
    ['re_4', 'txn_re_4', 're_4', null, null], ['re_3', null, null, null, null], ['re_2', 'txn_re_2', 're_2', 'txn_f_re_2', 're_2'], ['re_1', 'txn_re_1', 're_1', null, null],
  ])
})

// JSON is NOT a lossless image of the evidence in general: it writes NaN, Infinity and -Infinity as null and -0 as 0 (R11 pins it). The reports below are JSON-VALUED - strings, whole numbers, booleans, null - because
// that is all a reading of Stripe's objects produces; the awkward numbers can only come from the caller's own requested refunds, which the reader hands back exactly (R11) and which no JSON image may replace.
test('I7 the report of an ordinary reading is plain JSON-valued data: written as JSON and read back it is the same, with no undefined, no NaN, no function (this says nothing about NaN, Infinity or -0, which JSON does not keep: see R11)', async () => {
  for (const world of [W(), randomWorld(5), randomWorld(6)]) {
    const result = await read(world)
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  }
  const failed = W()
  failed.fault('refunds.list', 1, fail.sdk(sdkErrors.rateLimit))
  const result = await read(failed)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

// the read-set: which properties of the evidence does the funds model REALLY read? A recorder around the evidence answers; the answer must stay inside what the reader carries. If a later change of
// the model reads one more field, this fails instead of the new field silently missing from the evidence.
function recorded(root: unknown, name: string, into: Set<string>): any {
  const wrap = (value: any, at: string): any => {
    if (value === null || typeof value !== 'object') return value
    return new Proxy(value, {
      get(target, property, receiver) {
        const child = Reflect.get(target, property, receiver)
        if (typeof property === 'symbol') return child
        if (Array.isArray(target)) return /^\d+$/.test(property) ? wrap(child, `${at}[]`) : child
        into.add(`${at}.${property}`)
        return wrap(child, `${at}.${property}`)
      },
    })
  }
  return wrap(root, name)
}
function allowedReadSet(): Set<string> {
  const out = new Set<string>(['evidence.paymentIntent', 'evidence.charge', 'evidence.refunds', 'evidence.disputes', 'evidence.requestedRefunds', 'evidence.refunds.data', 'evidence.refunds.has_more', 'evidence.disputes.data', 'evidence.disputes.has_more',
    'evidence.requestedRefunds[].id', 'evidence.requestedRefunds[].amount', 'evidence.requestedRefunds[].currency'])
  const fields = (base: string, kind: keyof typeof EXPECTED_FIELDS) => { for (const field of EXPECTED_FIELDS[kind]) out.add(`${base}.${field}`) }
  fields('evidence.paymentIntent', 'paymentIntent'); out.add('evidence.paymentIntent.latest_charge.id')
  fields('evidence.charge', 'charge'); out.add('evidence.charge.payment_intent.id')
  for (const [base, kind] of [['evidence.refunds.data[]', 'refund'], ['evidence.disputes.data[]', 'dispute']] as const) {
    fields(base, kind)
    for (const slot of ['payment_intent', 'charge']) out.add(`${base}.${slot}.id`)
  }
  for (const slot of ['balance_transaction', 'failure_balance_transaction']) { fields(`evidence.refunds.data[].${slot}`, 'transaction'); out.add(`evidence.refunds.data[].${slot}.source.id`) }
  fields('evidence.disputes.data[].balance_transactions[]', 'transaction'); out.add('evidence.disputes.data[].balance_transactions[].source.id')
  return out
}
test('I8 the READ-SET (at least a thousand worlds, with requested refunds, with faults): everything the funds model reads of the evidence is a field the reader carries - no field it needs is missing, no field it does not need is there', async () => {
  const { computeFundsPosition } = await loadP1()
  const allowed = allowedReadSet()
  const seen = new Set<string>()
  for (let seed = 1; seed <= Math.max(1000, WORLDS); seed++) {
    const world = randomWorld(seed)
    const random = mulberry32(seed * 31)
    if (seed % 3 === 0) pick(random, FAULT_MENU)(world, random)
    const result = await read(world, { request: seed % 2 === 0 ? { requestedRefunds: [{ id: `re_q${seed}`, amount: 3, currency: 'eur' }, { amount: 2 }] } : {} })
    const touched = new Set<string>()
    computeFundsPosition(recorded(result.evidence, 'evidence', touched))
    const outside = [...touched].filter((path) => !allowed.has(path))
    assert.deepEqual(outside, [], `seed ${seed}: the model reads what the reader does not carry`)
    for (const path of touched) seen.add(path)
  }
  // and the guard has teeth: the model really does read the bulk of the set (a recorder that saw nothing would pass the check above)
  for (const path of ['evidence.paymentIntent.amount_received', 'evidence.charge.amount_refunded', 'evidence.refunds.data[].balance_transaction.amount', 'evidence.disputes.data[].balance_transactions[].reporting_category', 'evidence.requestedRefunds[].amount']) {
    assert.ok(seen.has(path), `the model never read ${path}: the recorder does not see what it should`)
  }
})

// =====================================================================================================================================================================
// J. Compatibility with the funds model (P1, P1-bis), monotonicity, provenance, and the quirks of the model that the reader cannot change
// =====================================================================================================================================================================
test('J2 the positions of the observed Test Mode scenarios come out of the reader as the model\'s own tables say (AR-2 A and B, SP1: dispute with a fee kept apart)', async () => {
  const table: Array<[string, (world: World) => void, [string, number, number | null, boolean]]> = [
    ['AR-2 A: refund pending', (w) => w.addRefund({ id: 're_a', amount: 20, status: 'pending' }), ['uncertain', 80, 100, false]],
    ['AR-2 A: refund succeeded', (w) => w.addRefund({ id: 're_a', amount: 20, status: 'succeeded' }), ['proven', 80, 80, false]],
    ['AR-2 B: refund failed, -20 / +20', (w) => w.addRefund({ id: 're_a', amount: 20, status: 'failed' }), ['proven', 100, 100, true]],
    ['SP1: dispute lost, -100 with a fee of 2000', (w) => w.addDispute({ id: 'dp_1', amount: 100, status: 'lost', fee: 2000 }), ['proven', 0, 0, true]],
    ['SP1: dispute won, +100, fee not given back', (w) => w.addDispute({ id: 'dp_1', amount: 100, status: 'won', fee: 2000 }), ['proven', 100, 100, true]],
  ]
  for (const [name, setup, [certainty, lower, upper, final]] of table) {
    const world = W()
    setup(world)
    const p = await position((await read(world)).evidence)
    assert.deepEqual([p.certainty, p.retainedLowerCents, p.retainedUpperCents, p.final], [certainty, lower, upper, final], name)
    if (name.startsWith('SP1')) assert.equal(p.fees.disputeCents, 2000, name)
  }
})

test('J4 P1-bis: a total refund that succeeded is zero in the snapshot only; J5 a KNOWN LIMIT of the model, pinned: "at least 1 is held" is NO after it (the model answers from its best reading)', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 100, status: 'succeeded' })
  const { retainedAtLeast, retainedIsZero } = await loadP1()
  const p = await position((await read(world)).evidence)
  assert.equal(retainedIsZero(p), 'unknown')
  assert.equal(retainedAtLeast(p, 1), 'no')
})

const NAMED_DEGRADATIONS: Array<[string, (world: World) => void]> = FAULT_MENU.map((fault, index) => [`fault ${index}`, (world) => fault(world, mulberry32(index + 1))])
test('J6 MONOTONICITY on coherent worlds (fixed seeds, every degradation of the menu): a degraded reading is never more favourable than the full one - proven only if equal to it, otherwise its interval contains it; "at least n" and "nothing is held" say yes only if the full reading does', async () => {
  const { retainedAtLeast, retainedIsZero } = await loadP1()
  for (let seed = 1; seed <= Math.max(200, Math.floor(WORLDS / 2)); seed++) {
    const full = await position(randomWorld(seed, { dirty: false }).oracleRaw())
    for (const [name, degrade] of NAMED_DEGRADATIONS) {
      const world = randomWorld(seed, { dirty: false })
      degrade(world)
      const result = await read(world)
      const d = await position(result.evidence)
      const label = `seed ${seed}, ${name}`
      if (d.certainty === 'proven') assert.deepEqual([d.retainedLowerCents, d.retainedUpperCents, d.final], [full.retainedLowerCents, full.retainedUpperCents, full.final], `${label}: proven but not the full reading`)
      assert.ok(d.retainedLowerCents <= full.retainedLowerCents, `${label}: a higher lower bound`)
      assert.ok(d.retainedUpperCents === null || (full.retainedUpperCents !== null && d.retainedUpperCents >= full.retainedUpperCents), `${label}: a lower upper bound`)
      for (const amount of [1, 10, Math.floor((full.collectedCents ?? 100) / 2), full.collectedCents ?? 100]) {
        if (retainedAtLeast(d, amount) === 'yes') assert.equal(retainedAtLeast(full, amount), 'yes', `${label}: "at least ${amount}"`)
      }
      if (retainedIsZero(d) === 'yes') assert.equal(retainedIsZero(full), 'yes', `${label}: "nothing is held"`)
    }
  }
})

test('J7 I1 FAIL-CLOSED (fixed seeds, worlds that change while they are read, with faults): whenever the structure is incomplete or the observation is not clean, BOTH lists are degraded and the funds model is uncertain - even for a caller who reads nothing of the report', async () => {
  for (let seed = 1; seed <= WORLDS; seed++) {
    const world = randomWorld(seed)
    const labels = scheduleRandomEvents(world, seed)
    const random = mulberry32(seed * 2654435761)
    if (random() < 0.5) pick(random, FAULT_MENU)(world, random)
    const result = await read(world)
    const label = `seed ${seed} [${labels.join(' ')}]`
    assertFailClosed(result, label)
    const p = await position(result.evidence)
    if (!isClean(result)) assert.equal(p.certainty, 'uncertain', `${label}: ${JSON.stringify(result.reading.structure.incomplete)} ${result.reading.temporal.observation}`)
    assertNoCanary(result, label)
    assert.deepEqual(world.mutationAttempts, [], label)
  }
})

test('J8a I1b\' STILL WORLD: when nothing changes and the structure is complete, the evidence is the whole reading of the world - for any page size, down to one refund per page', async () => {
  for (let seed = 1; seed <= Math.max(200, Math.floor(WORLDS / 2)); seed++) {
    const world = randomWorld(seed)
    const random = mulberry32(seed * 977)
    const result = await read(world, { options: { pageSize: between(random, 1, 3), maxPages: 50, maxMovementReads: 100 } })
    assert.equal(result.reading.structure.complete, true, `seed ${seed}`)
    assert.deepEqual(result.evidence, expectedFromOracle(world.oracleRaw()), `seed ${seed}`)
  }
})

// J8b I1c PROVENANCE, in three classes that are never mixed: (a) the objects the (simulated) Stripe RETURNED - each object of the evidence is the projection of one of them, in the order returned; (b) the refunds the
// CALLER asked for - a COPY of the caller's own words (id, amount, currency), taken before the first await, never the caller's array or objects and never presented as an answer of Stripe; (c) the metadata of
// the reading (counts, times, parts) - derived, outside this proof.
test('J8b I1c PROVENANCE (fixed seeds, worlds that change while they are read): every object of the evidence is the projection of an object the fake RETURNED in this reading, in the order returned; nothing is invented, nothing is older than the start; the requested refunds are a copy of the caller\'s words; the counts are the calls', async () => {
  for (let seed = 1; seed <= WORLDS; seed++) {
    const world = randomWorld(seed)
    scheduleRandomEvents(world, seed)
    const requested = [{ id: `re_q${seed}`, amount: 2 }]
    const result = await read(world, { request: { requestedRefunds: requested }, options: { pageSize: 1 + (seed % 3) } })
    const label = `seed ${seed}`
    // (a)
    const answers = (method: Method) => world.returned.filter((entry) => entry.method === method && entry.response !== undefined).map((entry) => entry.response as Rec)
    const transactions = new Map<string, Rec>()
    for (const answer of answers('balanceTransactions.retrieve')) transactions.set(answer.id, answer)
    const unresolved = (id: string) => transactions.get(id)
    const expectedRefunds = answers('refunds.list').flatMap((page) => page.data).map((raw: Rec) => expectedProjection('refund', raw, unresolved))
    const expectedDisputes = answers('disputes.list').flatMap((page) => page.data).map((raw: Rec) => expectedProjection('dispute', raw))
    assert.deepEqual(result.evidence.refunds?.data ?? [], expectedRefunds, `${label}: refunds`)
    assert.deepEqual(result.evidence.disputes?.data ?? [], expectedDisputes, `${label}: disputes`)
    const payments = answers('paymentIntents.retrieve')
    const last = payments[payments.length - 1]
    assert.deepEqual(result.evidence.paymentIntent, expectedProjection('paymentIntent', last), `${label}: the payment is the last one read`)
    assert.deepEqual(result.evidence.charge, last.latest_charge === null ? null : expectedProjection('charge', last.latest_charge), `${label}: the charge is the one of that read`)
    for (const call of world.calls) assert.ok(call.atMs >= (result.reading.temporal.startedAtMs as number), `${label}: a call before the start`)
    // (b)
    assert.deepStrictEqual(result.evidence.requestedRefunds, requested, `${label}: the caller's own words`)
    assert.notStrictEqual(result.evidence.requestedRefunds, requested, `${label}: as a copy, never the caller's array`)
    // (c)
    assert.equal(result.reading.counts.calls, world.calls.length, label)
    assert.equal(result.reading.counts.refundPages, world.callsOf('refunds.list').length, label)
    assert.equal(result.reading.counts.disputePages, world.callsOf('disputes.list').length, label)
    assert.equal(result.reading.counts.movementReads, world.callsOf('balanceTransactions.retrieve').length, label)
    assert.equal(result.reading.temporal.startedAtMs, world.calls[0].atMs, label)
  }
})

test('J9a KNOWN QUIRK of the model, pinned: with the charge NOT read and an aggregate that lags behind the refunds, the funds model\'s UPPER bound goes DOWN (80 instead of 100) - it touches only the "no" answers of "at least n"; the reader cannot change it, and the position is uncertain either way', async () => {
  const lagging = () => { const world = W(); world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' }); world.chargeOverride = { amount_refunded: 0 }; return world }
  const full = await position((await read(lagging())).evidence)
  const world = lagging()
  world.ignoreExpand = true
  const degraded = await position((await read(world)).evidence)
  const { retainedAtLeast } = await loadP1()
  assert.deepEqual([full.certainty, full.retainedLowerCents, full.retainedUpperCents], ['uncertain', 80, 100])
  assert.deepEqual([degraded.certainty, degraded.retainedLowerCents, degraded.retainedUpperCents], ['uncertain', 0, 80])
  assert.equal(retainedAtLeast(full, 90), 'unknown')
  assert.equal(retainedAtLeast(degraded, 90), 'no')
})

test('J9b KNOWN QUIRK of the model, neutralised by the reader: a movement left as an ID hides its contradiction (the model alone says "proven 80"), the reader never hands it over as complete', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  ;(world.transactions.get('txn_re_a') as Rec).amount = -30
  ;(world.transactions.get('txn_re_a') as Rec).net = -30
  const raw = world.oracleRaw()
  const withId = { ...expectedFromOracle(raw) } as Rec
  withId.refunds = { data: [{ ...withId.refunds.data[0], balance_transaction: 'txn_re_a' }], has_more: false }
  const alone = await position(withId)
  assert.deepEqual([alone.certainty, alone.retainedLowerCents, alone.retainedUpperCents], ['proven', 80, 80], 'the model alone: the id hides the -30')
  const unreadable = W()
  unreadable.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  ;(unreadable.transactions.get('txn_re_a') as Rec).amount = -30
  const viaReader = await position((await read(unreadable, { options: { maxMovementReads: 0 } })).evidence)
  assert.equal(viaReader.certainty, 'uncertain')
  const readable = await position((await read(world)).evidence)
  assert.deepEqual([readable.certainty, readable.retainedLowerCents, readable.retainedUpperCents], ['uncertain', 0, 100], 'read, the contradiction is visible')
})

test('J9c KNOWN LIMIT, pinned: an entry that Stripe leaves OUT of a list that says it is complete cannot be known to the reader - here a refund that waits for an action, which the aggregate does not count: the model says "proven" where the world is not', async () => {
  const world = W()
  world.addRefund({ id: 're_ra', amount: 20, status: 'requires_action' })
  world.fault('refunds.list', undefined, fail.transform((page) => { page.data = page.data.filter((entry: Rec) => entry.id !== 're_ra'); return page }))
  const result = await read(world)
  assert.equal(isClean(result), true, 'nothing in the reading shows the omission')
  const shown = await position(result.evidence)
  const reality = await position(world.oracleRaw())
  assert.deepEqual([shown.certainty, shown.retainedLowerCents], ['proven', 100])
  assert.deepEqual([reality.certainty, reality.retainedLowerCents], ['uncertain', 80])
  assert.ok(result.reading.temporal.notVerified.includes('new_entries_after_list_read'))
})

// the closing read can be wrong in ways the opening one cannot hide: a different payment, a different type, a mode that is gone or changed, an answer that is not one, a failure, a charge that no longer holds
const CLOSING_CASES: Array<[string, Act, string[], string, 'not_done' | 'different']> = [
  ['another payment id', fail.transform((r) => ({ ...r, id: 'pi_other' })), ['payment_intent_identity'], 'identity_mismatch', 'not_done'],
  ['another type', fail.transform((r) => ({ ...r, object: 'charge' })), ['payment_intent_identity'], 'identity_mismatch', 'not_done'],
  ['no mode', fail.transform((r) => { delete r.livemode; return r }), ['mode_unverified'], 'mode_unverified', 'not_done'],
  ['the other mode', fail.transform((r) => ({ ...r, livemode: !r.livemode })), ['mode_mixed'], 'mode_mismatch', 'not_done'],
  ['an answer that is not an object', fail.resolve('oops'), [], 'malformed_response', 'not_done'],
  ['a failure of the call', fail.sdk(sdkErrors.rateLimit), [], 'rate_limit', 'not_done'],
  ['a charge that came back as an id', fail.transform((r) => { r.latest_charge = r.latest_charge.id; return r }), [], '', 'different'],
  ['a charge that names another payment', fail.transform((r) => { r.latest_charge.payment_intent = 'pi_other'; return r }), [], '', 'different'],
  ['a charge in the other mode', fail.transform((r) => { r.latest_charge.livemode = !r.latest_charge.livemode; return r }), ['mode_mixed'], 'mode_mismatch', 'different'],
  ['a charge without a mode', fail.transform((r) => { delete r.latest_charge.livemode; return r }), ['mode_unverified'], 'mode_unverified', 'different'],
]
test('H15 the CLOSING read is checked as strictly as the first: a wrong payment, type or mode, an answer that is not one, a failure - the comparison is not done, the evidence stays the first read\'s, the reading is "not verifiable" (or the structure incomplete) and both lists are degraded', async () => {
  for (const [name, act, reasons, kind, recheck] of CLOSING_CASES) {
    const world = W()
    world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
    world.fault('paymentIntents.retrieve', 2, act)
    const result = await read(world)
    assert.equal(result.reading.temporal.paymentIntentRecheck, recheck, name)
    assert.deepEqual(reasonsOf(result), reasons, name)
    assert.equal(result.reading.structure.complete, reasons.length === 0, name)
    if (kind) assert.deepEqual(result.reading.failures.map((entry) => [entry.call, entry.kind]), [['paymentIntents.retrieve', kind]], name)
    assert.notEqual(result.reading.temporal.observation, 'no_change_observed', name)
    assert.deepEqual(result.evidence.paymentIntent, expectedProjection('paymentIntent', world.piObject(true)), `${name}: the evidence stays the first read's`)
    assertFailClosed(result, name)
    assert.equal((await position(result.evidence)).certainty, 'uncertain', name)
  }
})

test('H16 the closing read tells apart what JSON would make equal: a null that becomes NaN or Infinity, a zero that becomes minus zero, a number that becomes its own text - each is a DIFFERENCE', async () => {
  const cases: Array<[string, unknown, unknown]> = [['null -> NaN', null, Number.NaN], ['null -> Infinity', null, Number.POSITIVE_INFINITY], ['0 -> -0', 0, -0], ['5 -> "5"', 5, '5'], ['null -> "null"', null, 'null'], ['false -> 0', false, 0]]
  for (const [name, before, after] of cases) {
    const world = W()
    world.chargeOverride = { amount_refunded: before }
    world.at('T3', (w) => { w.chargeOverride = { amount_refunded: after } }, name)
    const result = await read(world)
    assert.equal(result.reading.temporal.paymentIntentRecheck, 'different', name)
    assertFailClosed(result, name)
  }
  const same = W()
  same.chargeOverride = { amount_refunded: 0 }
  same.at('T3', (w) => { w.chargeOverride = { amount_refunded: 0 } })
  assert.equal((await read(same)).reading.temporal.paymentIntentRecheck, 'same')
})

test('C12 the default cap of movement reads is twenty: with twenty-five refunds that succeeded, twenty balance transactions are read, five stay ids, and the reading says it is incomplete', async () => {
  const world = W({ amount: 1000000 })
  for (let index = 1; index <= 25; index++) world.addRefund({ id: `re_${String(index).padStart(2, '0')}`, amount: index, status: 'succeeded' })
  const result = await read(world)
  assert.equal(world.callsOf('balanceTransactions.retrieve').length, 20)
  assert.deepEqual(result.reading.counts, { calls: 23, refundPages: 1, disputePages: 1, movementReads: 20, unresolvedMovements: 5 })   // the payment, one page of each list, twenty movements; no closing read when the structure is incomplete
  assert.deepEqual(reasonsOf(result), ['movements_unresolved'])
  assertFailClosed(result, 'C12')
})

test('E13 a walk that goes round in circles is stopped by EITHER guard alone: a last entry that was already a cursor (new entries on the page), and a page that shows nothing new (a cursor that is new)', async () => {
  const page = (world: World, wanted: string[], more: boolean) => ok({ object: 'list', has_more: more, url: '/v1/refunds', data: wanted.map((id) => clone(world.find('refunds', id))) })
  const reuse = refundsWorld(6)
  reuse.fault('refunds.list', 1, () => page(reuse, ['re_6', 're_5'], true))
  reuse.fault('refunds.list', 2, () => page(reuse, ['re_4', 're_5'], true))   // new entry, but the last one is the cursor already used
  reuse.fault('refunds.list', 3, () => page(reuse, ['re_3', 're_2'], false))
  const a = await read(reuse, { options: { pageSize: 2 } })
  assert.equal(reuse.callsOf('refunds.list').length, 2, 'stopped at the second page: the cursor "re_5" had been used')
  assert.deepEqual(reasonsOf(a), ['refunds_truncated'])
  assert.equal(a.evidence.refunds?.has_more, true)
  const stale = refundsWorld(6)
  stale.fault('refunds.list', 1, () => page(stale, ['re_6', 're_5'], true))
  stale.fault('refunds.list', 2, () => page(stale, ['re_5', 're_6'], true))   // nothing new; the last entry is a cursor that has NOT been used
  stale.fault('refunds.list', 3, () => page(stale, ['re_3', 're_2'], false))
  const b = await read(stale, { options: { pageSize: 2 } })
  assert.equal(stale.callsOf('refunds.list').length, 2, 'stopped at the second page: it showed nothing new')
  assert.deepEqual(reasonsOf(b), ['refunds_truncated'])
  assert.equal(b.reading.temporal.pagination, 'anomalous')
})

test('E14 an element of a page that is not an object (null, a string, a number, an array) is forwarded as a scalar - or as the marker - never dropped; in the disputes it also leaves the list unverified', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'pending' })
  world.addDispute({ id: 'dp_a', amount: 10, status: 'lost' })
  world.fault('refunds.list', 1, fail.transform((page) => { page.data = [null, 'oops', 5, ['x'], ...page.data]; return page }))
  world.fault('disputes.list', 1, fail.transform((page) => { page.data = [null, ...page.data]; return page }))
  const result = await read(world)
  const refunds = result.evidence.refunds?.data as unknown[]
  assert.equal(refunds.length, 5)
  assert.deepEqual(refunds.slice(0, 3), [null, 'oops', 5])
  assert.ok(typeof refunds[3] === 'string' && !/^[A-Za-z0-9_]+$/.test(refunds[3] as string), 'an array cannot travel: the marker does')
  assert.equal((refunds[4] as Rec).id, 're_a')
  assert.equal(result.evidence.disputes?.data.length, 2)
  assert.deepEqual(reasonsOf(result), ['mode_unverified'])
  assert.ok(codes(await position(result.evidence)).includes('conflict:invalid_evidence'))
})

test('E11 DISPUTES are walked the same way: pages of two, the cursor of each page, complete at the end; the same dispute on two pages is an anomaly; and the cap on pages cuts the walk and says so', async () => {
  const build = () => { const world = W({ amount: 100000 }); for (let index = 1; index <= 5; index++) world.addDispute({ id: `dp_${index}`, amount: index, status: 'lost' }); return world }
  const walked = build()
  const result = await read(walked, { options: { pageSize: 2 } })
  assert.deepEqual(walked.callsOf('disputes.list').map((call) => call.params), [
    { payment_intent: 'pi_t1', limit: 2 }, { payment_intent: 'pi_t1', limit: 2, starting_after: 'dp_4' }, { payment_intent: 'pi_t1', limit: 2, starting_after: 'dp_2' },
  ])
  assert.deepEqual(ids(result.evidence.disputes), ['dp_5', 'dp_4', 'dp_3', 'dp_2', 'dp_1'])
  assert.equal(result.reading.counts.disputePages, 3)
  assert.equal(result.reading.structure.parts.disputes, 'complete')
  const repeated = build()
  repeated.fault('disputes.list', 2, () => ok({ object: 'list', has_more: false, url: '/v1/disputes', data: [clone(repeated.find('disputes', 'dp_4')), clone(repeated.find('disputes', 'dp_3'))] }))
  const second = await read(repeated, { options: { pageSize: 2 } })
  assert.equal(second.reading.temporal.pagination, 'anomalous')
  assert.equal(second.reading.temporal.observation, 'change_observed')
  assertFailClosed(second, 'E11 repeated')
  const capped = build()
  const third = await read(capped, { options: { pageSize: 2, maxPages: 2 } })
  assert.deepEqual(ids(third.evidence.disputes), ['dp_5', 'dp_4', 'dp_3', 'dp_2'])
  assert.equal(third.evidence.disputes?.has_more, true)
  assert.equal(third.reading.structure.parts.disputes, 'incomplete')
  assert.deepEqual(reasonsOf(third), ['disputes_truncated'])
  assert.deepEqual(third.reading.failures, [{ call: 'disputes.list', kind: 'budget', page: 3, ref: 'pages' }])
  assert.equal(capped.callsOf('disputes.list').length, 2)
})

test('G6b the BOUNDARY of the margin: with 502 ms left a call is made (a timeout of 1 ms); with 501 ms left it is not', async () => {
  for (const [latency, calls] of [[498, 2], [499, 1]] as Array<[number, number]>) {
    const world = W({ latencyMs: latency })
    world.honorTimeout = false
    world.addRefund({ id: 're_a', amount: 5, status: 'pending' })
    const result = await read(world, { options: { deadlineMs: 1000 } })
    assert.equal(world.calls.length >= 1 ? world.calls.filter((call) => call.method !== 'paymentIntents.retrieve').length > 0 : false, calls === 2, `latency ${latency}`)
    if (calls === 2) assert.equal(world.calls[1].options.timeout, 1, 'a timeout of 1 ms with 502 ms left')
    else assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'])
    assertFailClosed(result, `latency ${latency}`)
  }
})

test('G8e a request or options whose properties THROW when read are refused by name, without a call and without a rejection', async () => {
  const hostile = (base: Rec, key: string) => { const out = { ...base }; Object.defineProperty(out, key, { enumerable: true, get() { throw new Error(CANARIES.errorText) } }); return out }
  const good = { paymentIntentId: 'pi_t1', expectedLivemode: false }
  const world = W()
  const opts = { now: world.clock.now }
  for (const [request, options, ref] of [
    [hostile(good, 'paymentIntentId'), opts, 'paymentIntentId'], [hostile(good, 'expectedLivemode'), opts, 'expectedLivemode'], [hostile(good, 'requestedRefunds'), opts, 'requestedRefunds'],
    [good, hostile(opts, 'now'), 'now'], [good, hostile(opts, 'pageSize'), 'pageSize'], [good, hostile(opts, 'deadlineMs'), 'deadlineMs'],
  ] as Array<[unknown, unknown, string]>) {
    const result = await readRaw(world.client(), request, options)
    assert.deepEqual(result.reading.failures.map((entry) => entry.ref), [ref], ref)
    assertNoCanary(result, ref)
  }
  assert.deepEqual(world.calls, [])
})

test('G14 keys the reader does not know, in the request or in the options, are ignored: they change nothing and are not echoed', async () => {
  const plain = await read(W())
  const noisy = await read(W(), { request: { somethingElse: CANARIES.clientSecret, expectedLiveMode: true }, options: { deadline: 1, [CANARIES.email]: 1, retries: 5 } })
  assert.equal(JSON.stringify(noisy), JSON.stringify(plain))
  assertNoCanary(noisy, 'G14')
})

test('G15 the reader never rejects, even when something it did not foresee goes wrong: the evidence is "not read", the report says reader_error, the failures noted BEFORE are kept, the copy of the requested refunds it had already taken is still handed back, and nothing that was half-read is handed over', async () => {
  const world = refundsWorld(3)
  world.fault('refunds.list', 1, fail.sdk(sdkErrors.rateLimit))
  world.fault('disputes.list', 1, fail.sdk(sdkErrors.api))
  const requested = [{ id: 're_q', amount: 1 }]
  const original = JSON.stringify
  let seen = 0
  let result: StripeFundsRead
  try {
    // the second failure to be noted breaks the reader's own bookkeeping
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => { if (value && typeof value === 'object' && 'kind' in (value as object) && ++seen === 2) throw new Error('JSON.stringify broken on purpose'); return (original as (...args: unknown[]) => string)(value, ...rest) }) as typeof JSON.stringify
    result = await read(world, { request: { requestedRefunds: requested } })
  } finally { JSON.stringify = original }
  assert.deepEqual(result.evidence.paymentIntent, null)
  assert.deepEqual([result.evidence.charge, result.evidence.refunds, result.evidence.disputes], [null, null, null])
  assert.deepStrictEqual(result.evidence.requestedRefunds, [{ id: 're_q', amount: 1 }], 'the copy taken at the start')
  assert.notStrictEqual(result.evidence.requestedRefunds, requested, 'and not the caller\'s array')
  requested[0].amount = 424242   // the caller changes its own value after the reading: what was handed back does not move
  requested.push({ id: 're_late', amount: 1 })
  assert.deepStrictEqual(result.evidence.requestedRefunds, [{ id: 're_q', amount: 1 }])
  assert.deepEqual(result.reading.structure, { complete: false, parts: { paymentIntent: 'not_read', charge: 'not_read', refunds: 'not_read', disputes: 'not_read', movements: 'not_needed', mode: 'unverified' }, incomplete: ['reader_error'] })
  assert.deepEqual(result.reading.failures, [{ call: 'refunds.list', page: 1, kind: 'rate_limit', statusCode: 429 }, { call: 'reader', kind: 'internal_error' }])
  assert.equal(result.reading.temporal.observation, 'not_verifiable')
  assert.equal(result.reading.temporal.notVerified, (await load()).FUNDS_READ_NOT_VERIFIED)
  assert.equal(result.reading.counts.calls, 3)
  const kept = await readRaw(world.client(), { paymentIntentId: 'pi_t1', expectedLivemode: false }, { now: world.clock.now })
  assert.ok(kept.reading.structure.parts.paymentIntent === 'verified', 'and a normal reading afterwards is a normal reading (no state was left behind)')
})

test('I11 each result is its own: changing one (its lists, its arrays, its report) changes nothing in another, and nothing in the frozen constants', async () => {
  const build = () => { const world = W(); world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' }); return world }
  const a = await read(build())
  const b = await read(build())
  const before = JSON.stringify(b)
  ;(a.evidence.refunds as any).data.push({ id: 're_x' })
  ;(a.evidence.refunds as any).data[0].amount = 999
  ;(a.evidence.paymentIntent as any).status = 'canceled'
  a.reading.failures.push({ call: 'input', kind: 'invalid_input' })
  a.reading.structure.incomplete.push('reader_error')
  a.reading.temporal.signals.push('pagination_anomaly')
  a.reading.counts.calls = 99
  assert.equal(JSON.stringify(b), before)
  assert.equal(JSON.stringify(await read(build())), before)
  const { FUNDS_READ_NOT_VERIFIED } = await load()
  assert.equal(FUNDS_READ_NOT_VERIFIED.length, 9)
})

test('I12 numbers far outside what a payment holds (beyond the safe integers, infinite, not a number, negative zero) are forwarded as they are; the funds model refuses them, the reader does not touch them', async () => {
  const world = W()
  world.addRefund({ id: 're_big', amount: 20, status: 'pending', over: { amount: Number.MAX_SAFE_INTEGER + 2 } })
  world.addRefund({ id: 're_inf', amount: 20, status: 'pending', over: { amount: Number.POSITIVE_INFINITY } })
  world.addRefund({ id: 're_nan', amount: 20, status: 'pending', over: { amount: Number.NaN } })
  world.addRefund({ id: 're_zero', amount: 20, status: 'pending', over: { amount: -0 } })
  const result = await read(world)
  const byId = Object.fromEntries((result.evidence.refunds?.data as Rec[]).map((entry) => [entry.id, entry.amount]))
  assert.equal(byId.re_big, Number.MAX_SAFE_INTEGER + 2)
  assert.equal(byId.re_inf, Number.POSITIVE_INFINITY)
  assert.ok(Number.isNaN(byId.re_nan))
  assert.ok(Object.is(byId.re_zero, -0))
  assert.notEqual((await position(result.evidence)).certainty, 'proven')
})

// =====================================================================================================================================================================
// K. On the WIRE: the real Stripe SDK over a fake `httpClient`, with every network attempt refused and recorded
// =====================================================================================================================================================================
async function withNetworkBlocked<T>(work: () => Promise<T>): Promise<{ result: T; attempts: string[] }> {
  const attempts: string[] = []
  const restore = installNetworkRefusal(attempts)
  try { return { result: await work(), attempts } } finally { restore() }
}
async function quietly<T>(work: () => Promise<T>): Promise<T> {   // the SDK warns (on stderr) when it is called the wrong way: the control below does it on purpose
  const original = process.emitWarning
  process.emitWarning = (() => undefined) as typeof process.emitWarning
  try { return await work() } finally { process.emitWarning = original }
}
const wireWorld = () => {
  const world = W({ pi: 'pi_k', charge: 'ch_k' })
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  world.addRefund({ id: 're_b', amount: 5, status: 'pending' })
  world.addRefund({ id: 're_c', amount: 6, status: 'pending' })
  world.addDispute({ id: 'dp_1', amount: 50, status: 'lost' })
  return world
}
test('K1 THE WIRE: the real SDK sends only GET requests, on exactly these paths and queries, filtered by the payment on every page, with an explicit timeout, no idempotency key, no account header, no body - and the reading is the very one the direct client gives', async () => {
  const world = wireWorld()
  const { stripe, requests } = wire(world)
  const { result, attempts } = await withNetworkBlocked(() => read(world, { client: stripe, options: { pageSize: 2 } }))
  assert.deepEqual(attempts, [], 'no real connection was attempted')
  assert.deepEqual(requests.map((request) => request.path), [
    '/v1/payment_intents/pi_k?expand[0]=latest_charge',
    '/v1/refunds?payment_intent=pi_k&limit=2',
    '/v1/refunds?payment_intent=pi_k&limit=2&starting_after=re_b',
    '/v1/disputes?payment_intent=pi_k&limit=2',
    '/v1/balance_transactions/txn_re_a',
    '/v1/payment_intents/pi_k?expand[0]=latest_charge',
  ])
  for (const request of requests) {
    assert.equal(request.method, 'GET')
    assert.deepEqual([request.host, request.protocol], ['api.stripe.com', 'https'])
    assert.ok(Number.isInteger(request.timeout) && request.timeout >= 1 && request.timeout <= 5000, `timeout ${request.timeout}`)
    assert.ok(!request.requestData, 'no body on a GET')
    assert.deepEqual(Object.keys(request.headers).filter((name) => /idempotency|stripe-account|stripe-context/i.test(name)), [])
  }
  assert.ok(requests.every((request) => !(request.path.startsWith('/v1/refunds') || request.path.startsWith('/v1/disputes')) || request.path.includes('payment_intent=pi_k')), 'no list without its filter')
  const direct = await read(wireWorld(), { options: { pageSize: 2 } })
  assert.deepEqual(result.evidence, direct.evidence)
  assert.deepEqual(result.reading.structure, direct.reading.structure)
  assert.deepEqual(result.reading.counts, direct.reading.counts)
  assert.deepEqual(result.reading.failures, direct.reading.failures)
  assert.equal(result.reading.structure.complete, true)
})

test('K2 CONTROL: the same SDK called the wrong way - filters and options in ONE object - sends an UNFILTERED request and brings back the refunds of other payments: it is what the reader\'s two arguments avoid', async () => {
  const world = wireWorld()
  for (let index = 1; index <= 3; index++) world.addForeignRefund({ id: `re_foreign_${index}` })
  const { stripe, requests } = wire(world)
  const wrong: any = await quietly(() => (stripe.refunds.list as any)({ payment_intent: 'pi_k', limit: 100, timeout: 5000 }))
  assert.equal(requests[0].path, '/v1/refunds', 'no filter at all went out')
  assert.ok(wrong.data.some((entry: Rec) => String(entry.id).startsWith('re_foreign_')))
  requests.length = 0
  const right: any = await stripe.refunds.list({ payment_intent: 'pi_k', limit: 100 }, { timeout: 5000 })
  assert.equal(requests[0].path, '/v1/refunds?payment_intent=pi_k&limit=100')
  assert.ok(right.data.every((entry: Rec) => !String(entry.id).startsWith('re_foreign_')))
})

const WIRE_FAULTS: Array<[string, import('./_fake-stripe-funds').WireFault, string]> = [
  ['401', { status: 401, body: { error: { type: 'authentication_error', message: CANARIES.errorText } } }, 'authentication'],
  ['403', { status: 403, body: { error: { type: 'invalid_request_error', message: CANARIES.errorText } } }, 'permission'],
  ['404 resource_missing', { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: CANARIES.errorText } } }, 'invalid_request'],
  ['429', { status: 429, body: { error: { type: 'rate_limit_error', message: CANARIES.errorText } } }, 'rate_limit'],
  ['500', { status: 500, body: { error: { type: 'api_error', message: CANARIES.errorText } } }, 'api'],
  ['a timeout of the transport', { network: (Stripe as any).HttpClient.makeTimeoutError() }, 'timeout'],
]
test('K3 the errors the SDK builds from real HTTP answers (401, 403, 404, 429, 500, a timeout) are classified, the list is "not read", the failed call is made ONCE (the SDK\'s own retries are off: the option travels with each request) and neither the key nor the text of the error reaches the report', async () => {
  for (const [name, fault, kind] of WIRE_FAULTS) {
    const world = wireWorld()
    const { stripe, requests } = wire(world, { 2: fault }, { maxNetworkRetries: 2 })
    const { result, attempts } = await withNetworkBlocked(() => quietly(() => read(world, { client: stripe, options: { pageSize: 2 } })))
    assert.deepEqual(attempts, [], name)
    assert.equal(result.evidence.refunds, null, name)
    assert.equal(result.reading.failures[0].kind, kind, name)
    assert.equal(result.reading.failures[0].call, 'refunds.list', name)
    assert.equal(requests.filter((request) => request.path.startsWith('/v1/refunds')).length, 1, `${name}: the failed call was repeated`)
    assert.ok(!JSON.stringify(result).includes(FAKE_KEY), name)
    assertNoCanary(result, name)
    assertFailClosed(result, name)
  }
})

test('K4 an answer that is not JSON at all comes out of the SDK as an error and out of the reader as a failed call: the list is not read, never empty', async () => {
  const world = wireWorld()
  const { stripe } = wire(world, { 2: { status: 200, raw: 'this is not json' } })
  const result = await quietly(() => read(world, { client: stripe, options: { pageSize: 2 } }))
  assert.equal(result.evidence.refunds, null)
  assert.equal(result.reading.failures[0].call, 'refunds.list')
  assert.ok(['api', 'unknown', 'malformed_response', 'connection'].includes(result.reading.failures[0].kind), result.reading.failures[0].kind)   // the SDK 19.3.1 reports it as a connection error
})

// =====================================================================================================================================================================
// M. Integrity: mode, identity, type, references, movements, omissions
// =====================================================================================================================================================================
test('M2 the mode the caller expects is the one every object declares - Test (false) and Live (true) alike: verified, and "observed" says so', async () => {
  for (const livemode of [false, true]) {
    const world = W({ livemode })
    world.addDispute({ id: 'dp_1', amount: 100, status: 'lost' })
    const result = await read(world)
    assert.equal(result.reading.structure.parts.mode, 'verified', `livemode ${livemode}`)
    assert.deepEqual(result.reading.mode, { expected: livemode, observed: livemode ? 'live' : 'test' })
    assert.equal(result.reading.structure.complete, true)
  }
})

test('M3 a payment whose mode is missing, null, a string or a number is NOT read: one call, "mode unverified", nothing else asked; M4 one whose mode is the other one: "mismatch", one call', async () => {
  for (const livemode of [undefined, null, 'false', 'true', 0, 1, {}]) {
    const world = W()
    world.piOverride = { livemode }
    const result = await read(world)
    const label = JSON.stringify(livemode) ?? 'missing'
    assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'], label)
    assert.deepEqual(reasonsOf(result), ['mode_unverified'], label)
    assert.equal(result.reading.structure.parts.mode, 'unverified', label)
    assert.equal(result.reading.mode.observed, 'unknown', label)
    assert.deepEqual(result.reading.failures, [{ call: 'paymentIntents.retrieve', kind: 'mode_unverified' }], label)
    assert.deepEqual(result.evidence, { paymentIntent: null, charge: null, refunds: null, disputes: null }, label)
  }
  for (const expected of [false, true]) {
    const world = W({ livemode: !expected })
    const result = await read(world, { request: { expectedLivemode: expected } })
    assert.deepEqual(methodsOf(world), ['paymentIntents.retrieve'])
    assert.deepEqual(reasonsOf(result), ['mode_mismatch'])
    assert.equal(result.reading.structure.parts.mode, 'mismatch')
    assert.deepEqual(result.reading.mode, { expected, observed: expected ? 'test' : 'live' })
    assert.deepEqual(result.reading.failures, [{ call: 'paymentIntents.retrieve', kind: 'mode_mismatch' }])
    assert.deepEqual(result.evidence, { paymentIntent: null, charge: null, refunds: null, disputes: null })
  }
})

test('M5 a charge whose mode is missing is withheld (unverified); one in the OTHER mode is withheld too (mixed: the objects disagree) - the reading is incomplete and both lists are degraded', async () => {
  const missing = W()
  missing.chargeOverride = { livemode: undefined }
  const a = await read(missing)
  assert.deepEqual(reasonsOf(a), ['mode_unverified'])
  assert.equal(a.evidence.charge, null)
  assert.equal(a.reading.structure.parts.charge, 'withheld')
  assert.equal(a.reading.structure.parts.mode, 'unverified')
  assert.equal(a.reading.mode.observed, 'test')
  assert.deepEqual(a.reading.failures, [{ call: 'paymentIntents.retrieve', kind: 'mode_unverified', ref: 'latest_charge' }])
  assertFailClosed(a, 'M5 missing')
  const other = W()
  other.chargeOverride = { livemode: true }
  const b = await read(other)
  assert.deepEqual(reasonsOf(b), ['mode_mixed'])
  assert.equal(b.evidence.charge, null)
  assert.equal(b.reading.structure.parts.mode, 'mixed')
  assert.equal(b.reading.mode.observed, 'mixed')
  assert.deepEqual(b.reading.failures, [{ call: 'paymentIntents.retrieve', kind: 'mode_mismatch', ref: 'latest_charge' }])
  assertFailClosed(b, 'M5 mixed')
  for (const livemode of ['false', 1, null]) {
    const odd = W()
    odd.chargeOverride = { livemode }
    assert.deepEqual(reasonsOf(await read(odd)), ['mode_unverified'], JSON.stringify(livemode))
  }
})

test('M6 a dispute whose mode is missing or the other one makes the LIST of disputes incomplete (has_more true, what came is forwarded); M7 a payment in Test and a charge in Live are "mixed"', async () => {
  const missing = W()
  missing.addDispute({ id: 'dp_1', amount: 100, status: 'lost', over: { livemode: undefined } })
  const a = await read(missing)
  assert.deepEqual(reasonsOf(a), ['mode_unverified'])
  assert.equal(a.evidence.disputes?.has_more, true)
  assert.deepEqual(ids(a.evidence.disputes), ['dp_1'])
  assert.equal(a.reading.structure.parts.disputes, 'incomplete')
  assert.deepEqual(a.reading.failures, [{ call: 'disputes.list', kind: 'mode_unverified', page: 1 }])
  const other = W()
  other.addDispute({ id: 'dp_1', amount: 100, status: 'lost', over: { livemode: true } })
  const b = await read(other)
  assert.deepEqual(reasonsOf(b), ['mode_mixed'])
  assert.deepEqual(ids(b.evidence.disputes), ['dp_1'])
  assert.equal(b.reading.mode.observed, 'mixed')
  assert.deepEqual(b.reading.failures, [{ call: 'disputes.list', kind: 'mode_mismatch', page: 1 }])
  assertFailClosed(a, 'M6')
  assertFailClosed(b, 'M6')
})

test('M8 refunds and balance transactions do not declare a mode in the SDK\'s types: none is required of them (the reading is complete), and one that is declared anyway is ignored - it is neither checked nor carried', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded', over: { livemode: true } })
  ;(world.transactions.get('txn_re_a') as Rec).livemode = true
  const result = await read(world)
  assert.equal(result.reading.structure.complete, true)
  assert.equal(result.reading.structure.parts.mode, 'verified')
  assert.equal(result.reading.mode.observed, 'test')
  assert.ok(!allKeys(result.evidence).has('livemode'))
})

test('M9 the mode is read from the objects and from nothing else: not from the prefix of an id, not from the environment', async () => {
  const inTest = W({ pi: 'pi_live_looks_live', charge: 'ch_live_x', livemode: false })
  assert.deepEqual((await read(inTest)).reading.mode, { expected: false, observed: 'test' })
  const live = W({ pi: 'pi_test_looks_test', charge: 'ch_test_x', livemode: true })
  assert.deepEqual((await read(live)).reading.mode, { expected: true, observed: 'live' })
  const wrong = W({ pi: 'pi_test_looks_test', livemode: true })
  const result = await read(wrong, { request: { expectedLivemode: false } })
  assert.deepEqual(reasonsOf(result), ['mode_mismatch'])
})

test('M10 a charge that is not THIS payment\'s charge - another type, no id, an id that cannot be one, another payment, none - is withheld (charge_identity); an object reference to this payment and an id of the py_ kind are fine', async () => {
  const bad: Array<[string, Rec]> = [
    ['another type', { object: 'refund' }], ['no type', { object: undefined }], ['no id', { id: undefined }], ['an empty id', { id: '' }], ['a numeric id', { id: 5 }], ['an id with a space', { id: 'ch t1' }],
    ['another payment', { payment_intent: 'pi_other' }], ['another payment as an object', { payment_intent: { id: 'pi_other' } }], ['no payment', { payment_intent: undefined }], ['a payment that is null', { payment_intent: null }],
  ]
  for (const [name, over] of bad) {
    const world = W()
    world.chargeOverride = over
    const result = await read(world)
    assert.deepEqual(reasonsOf(result), ['charge_identity'], name)
    assert.equal(result.reading.structure.parts.charge, 'withheld', name)
    assert.equal(result.evidence.charge, null, name)
    assertFailClosed(result, name)
  }
  for (const over of [{ payment_intent: { id: 'pi_t1' } }, { id: 'py_3Abc' }]) {
    const world = W()
    world.chargeOverride = over
    const result = await read(world)
    assert.equal(result.reading.structure.parts.charge, 'verified', JSON.stringify(over))
    assert.equal(result.reading.structure.complete, true)
  }
})

test('M11 a latest_charge that stayed an id (or is missing) is "unexpanded": the charge is not evidence, the reading is incomplete; null is "none reported" - two different things', async () => {
  const unexpanded = W()
  unexpanded.ignoreExpand = true
  const a = await read(unexpanded)
  assert.equal(a.evidence.charge, null)
  assert.equal(a.evidence.paymentIntent?.latest_charge, 'ch_t1')
  assert.equal(a.reading.structure.parts.charge, 'unexpanded')
  assert.deepEqual(reasonsOf(a), ['charge_unexpanded'])
  assertFailClosed(a, 'M11')
  const absent = W()
  absent.piOverride = { latest_charge: undefined }
  const b = await read(absent)
  assert.deepEqual(reasonsOf(b), ['charge_unexpanded'])
  assert.ok(!('latest_charge' in (b.evidence.paymentIntent as object)), 'an absent field stays absent')
  const none = await read(W({ status: 'canceled', charge: null }))
  assert.equal(none.reading.structure.parts.charge, 'none_reported')
})

test('M12 movements left unresolved, in each of their three places (a refund\'s, a failed refund\'s second one, a dispute\'s), make the reading incomplete and both lists degraded', async () => {
  const refund = W(); refund.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  const failed = W(); failed.addRefund({ id: 're_f', amount: 20, status: 'failed' })
  const dispute = W(); dispute.addDispute({ id: 'dp_1', amount: 100, status: 'lost' }); dispute.inlineDisputeBts = false
  for (const [name, world, expectedUnresolved] of [['a refund', refund, 1], ['a failed refund', failed, 2], ['a dispute', dispute, 1]] as Array<[string, World, number]>) {
    const result = await read(world, { options: { maxMovementReads: 0 } })
    assert.equal(result.reading.structure.parts.movements, 'unresolved', name)
    assert.deepEqual(reasonsOf(result), ['movements_unresolved'], name)
    assert.equal(result.reading.counts.unresolvedMovements, expectedUnresolved, name)
    assertFailClosed(result, name)
  }
})

test('M15 a payment canceled, in motion or not yet paid, with NO charge: "none reported", no charge, no amount, no default - the lists stay as read, and nothing is filled in', async () => {
  for (const status of ['canceled', 'processing', 'requires_payment_method', 'requires_confirmation']) {
    const world = W({ status, charge: null })
    const result = await read(world)
    assert.equal(result.reading.structure.parts.charge, 'none_reported', status)
    assert.equal(result.evidence.charge, null, status)
    assert.equal(result.evidence.paymentIntent?.latest_charge, null, status)
    assert.deepEqual(result.evidence.refunds, { data: [], has_more: false }, status)
    assert.ok(!allKeys(result.evidence.charge).size, status)
  }
})

test('M17 NOTHING IS INVENTED: a field the answer does not have is not in the evidence - not null, not zero, not a default', async () => {
  const world = W()
  world.piOverride = { currency: undefined, status: undefined, amount_received: undefined }
  world.chargeOverride = { amount_captured: undefined, amount_refunded: undefined, currency: undefined, disputed: undefined }
  world.addRefund({ id: 're_a', amount: 20, status: 'pending', over: { currency: undefined, status: undefined, balance_transaction: undefined, failure_balance_transaction: undefined } })
  const result = await read(world)
  assert.deepEqual(result.evidence.paymentIntent, { id: 'pi_t1', latest_charge: { id: 'ch_t1' } })
  assert.deepEqual(result.evidence.charge, { id: 'ch_t1', payment_intent: 'pi_t1' })
  assert.deepEqual(result.evidence.refunds?.data[0], { id: 're_a', amount: 20, payment_intent: 'pi_t1', charge: 'ch_t1' })
})

// ---- M14: the matrix of OMISSIONS. Whatever the reader can recognise (a field, an object, a movement) never makes the funds model more favourable; the one thing it cannot recognise - an entry that Stripe leaves out of
// ---- a list that says it is complete - is counted, not hidden.
type Omission = { name: string; recognised: boolean; apply: (world: World, random: () => number) => void }
const dropField = (response: Rec, field: string, how: 'absent' | 'null') => { if (how === 'absent') delete response[field]; else response[field] = null }
const OMISSIONS: Omission[] = [
  ...(['amount_received', 'currency', 'status', 'latest_charge'] as const).flatMap((field) => (['absent', 'null'] as const).map((how): Omission => ({
    name: `the payment's ${field} ${how}`, recognised: true,
    apply: (world) => world.fault('paymentIntents.retrieve', undefined, fail.transform((r) => { dropField(r, field, how); return r })),
  }))),
  ...(['id', 'amount_captured', 'amount_refunded', 'currency', 'disputed', 'payment_intent'] as const).flatMap((field) => (['absent', 'null'] as const).map((how): Omission => ({
    name: `the charge's ${field} ${how}`, recognised: true,
    apply: (world) => world.fault('paymentIntents.retrieve', undefined, fail.transform((r) => { if (r.latest_charge && typeof r.latest_charge === 'object') dropField(r.latest_charge, field, how); return r })),
  }))),
  { name: 'the charge object (latest_charge: null)', recognised: true, apply: (world) => world.fault('paymentIntents.retrieve', undefined, fail.transform((r) => { r.latest_charge = null; return r })) },
  ...(['id', 'amount', 'currency', 'status', 'payment_intent', 'balance_transaction', 'failure_balance_transaction'] as const).flatMap((field) => (['absent', 'null'] as const).map((how): Omission => ({
    name: `a refund's ${field} ${how}`, recognised: true,
    apply: (world, random) => world.fault('refunds.list', undefined, fail.transform((page) => { if (page.data.length) dropField(page.data[Math.floor(random() * page.data.length)], field, how); return page })),
  }))),
  ...(['id', 'amount', 'currency', 'status', 'payment_intent', 'balance_transactions'] as const).flatMap((field) => (['absent', 'null'] as const).map((how): Omission => ({
    name: `a dispute's ${field} ${how}`, recognised: true,
    apply: (world, random) => world.fault('disputes.list', undefined, fail.transform((page) => { if (page.data.length) dropField(page.data[Math.floor(random() * page.data.length)], field, how); return page })),
  }))),
  { name: 'every balance transaction of a refund unreadable', recognised: true, apply: (world) => world.fault('balanceTransactions.retrieve', undefined, fail.sdk(() => sdkErrors.notFound('balance_transaction', 'x'))) },
  { name: 'every balance transaction of a dispute only an id', recognised: true, apply: (world) => { world.inlineDisputeBts = false } },
  { name: 'a refund entry left out of a list that says it is complete', recognised: false, apply: (world, random) => world.fault('refunds.list', undefined, fail.transform((page) => { if (page.data.length) page.data.splice(Math.floor(random() * page.data.length), 1); return page })) },
  { name: 'a dispute entry left out of a list that says it is complete', recognised: false, apply: (world, random) => world.fault('disputes.list', undefined, fail.transform((page) => { if (page.data.length) page.data.splice(Math.floor(random() * page.data.length), 1); return page })) },
]
test('M14 the matrix of omissions (at least a thousand coherent worlds, fixed seeds): nothing the reader can recognise as missing - a field, an object, a movement - ever makes the funds model more favourable than the whole reading; the entries left out of a complete list are the known limit and are counted', async (t) => {
  const counts = { recognisedCases: 0, recognisedPromoted: 0, unrecognisedCases: 0, unrecognisedPromoted: 0 }
  const offenders: string[] = []
  for (let seed = 1; seed <= Math.max(1000, WORLDS); seed++) {
    const random = mulberry32(seed * 40503)
    const omission = OMISSIONS[Math.floor(random() * OMISSIONS.length)]
    const world = randomWorld(seed, { dirty: false })
    const full = await position(world.oracleRaw())
    omission.apply(world, mulberry32(seed * 7))
    const shown = await position((await read(world)).evidence)
    const worse = await moreFavourable(shown, full)
    if (omission.recognised) { counts.recognisedCases++; if (worse) { counts.recognisedPromoted++; offenders.push(`seed ${seed}: ${omission.name}`) } } else { counts.unrecognisedCases++; if (worse) counts.unrecognisedPromoted++ }
  }
  t.diagnostic(`M14: ${JSON.stringify(counts)}`)
  assert.deepEqual(offenders.slice(0, 10), [], 'a recognisable omission made the model more favourable')
})

// =====================================================================================================================================================================
// Q. The shape of the report
// =====================================================================================================================================================================
test('Q1 the reasons of an incomplete structure come in the canonical order of the list, each once; the signals too', async () => {
  const { FUNDS_READ_STRUCTURE_REASONS, FUNDS_READ_TEMPORAL_SIGNALS } = await load()
  const world = refundsWorld(9)
  world.piOverride = { application_fee_amount: 10 }
  world.addRefund({ id: 're_s', amount: 3, status: 'succeeded' })
  const result = await read(world, { options: { pageSize: 2, maxPages: 2, maxMovementReads: 0 } })
  const found = result.reading.structure.incomplete
  assert.deepEqual(found, ['payment_flow_not_modeled', 'refunds_truncated', 'movements_unresolved'].filter((reason) => found.includes(reason as any)))
  assert.ok(found.length >= 2)
  const index = found.map((reason) => (FUNDS_READ_STRUCTURE_REASONS as readonly string[]).indexOf(reason))
  assert.ok(index.every((value, at) => value >= 0 && (at === 0 || value > index[at - 1])), JSON.stringify(found))
  const signalIndex = result.reading.temporal.signals.map((signal) => (FUNDS_READ_TEMPORAL_SIGNALS as readonly string[]).indexOf(signal))
  assert.ok(signalIndex.every((value, at) => value >= 0 && (at === 0 || value > signalIndex[at - 1])))
})

test('Q2 a failure has only the keys it needs - never undefined, never text of an error - and every ref is a name or an identifier', async () => {
  const world = W()
  world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  world.fault('balanceTransactions.retrieve', undefined, fail.sdk(sdkErrors.api))
  world.fault('disputes.list', undefined, fail.sdk(sdkErrors.notFound))
  const result = await read(world, { options: { maxPages: 1 } })
  assert.ok(result.reading.failures.length >= 2)
  for (const failure of result.reading.failures) {
    for (const [key, value] of Object.entries(failure)) {
      assert.ok(['call', 'kind', 'page', 'statusCode', 'code', 'ref'].includes(key), key)
      assert.notEqual(value, undefined, key)
    }
    if (failure.ref !== undefined) assert.match(failure.ref, /^[A-Za-z0-9_]{1,255}$/)
  }
  assertNoCanary(result, 'Q2')
})

test('Q3 an input that is refused is named and never quoted: a payment id carrying a secret in it does not appear in the report', async () => {
  const result = await read(W(), { request: { paymentIntentId: `pi_ ${CANARIES.clientSecret}` } })
  assert.deepEqual(result.reading.failures, [{ call: 'input', kind: 'invalid_input', ref: 'paymentIntentId' }])
  assertNoCanary(result, 'Q3')
})

// =====================================================================================================================================================================
// R. The requested refunds (D5): a CONTROLLED COPY, taken before the first await - never the caller's array, never its objects, only `id`, `amount` and `currency`
// =====================================================================================================================================================================
// What the reader checks is the TYPE and the STRUCTURE of what the caller handed over; the DOMAIN - the shape of an id, a positive whole amount, a currency, duplicates, conflicts - stays the funds model's.
// A list of requests is taken whole or refused whole: no partial copy, nothing repaired, and what is refused leaves nothing of the caller in the evidence or in the report.
const REQUESTED_LIMIT = 1000   // the reader's own technical limit on the NUMBER of requests: a protection of resources, not a financial threshold - it is not a parameter and it is not exported
const REFUSED_BY_NAME = [{ call: 'input', kind: 'invalid_input', ref: 'requestedRefunds' }]
const NOTHING_READ = { paymentIntent: null, charge: null, refunds: null, disputes: null }
const hasKey = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const boom = () => { throw new Error(CANARIES.errorText) }
// everything personal or secret that an object of the caller might carry along
const personal = (): Rec => ({
  email: CANARIES.email, name: CANARIES.name, phone: CANARIES.phone, address: { street: CANARIES.street }, client_secret: CANARIES.clientSecret, metadata: { note: CANARIES.metadata },
  receipt_url: CANARIES.receipt, evidence: { text: CANARIES.evidence }, nested: { deep: [CANARIES.fingerprint] },
})
const requestsOf = (): Rec[] => [{ id: 're_q1', amount: 30, currency: 'eur' }, { id: 're_q2', amount: 15 }, { amount: 5, currency: 'eur' }, { id: 're_q1', amount: 31 }]
// what the copy must be, written here and not taken from the reader: the three names, a key only where there is a value (undefined is "absent"), the caller's order, duplicates kept
const copyOf = (requests: Rec[]): Rec[] => requests.map((entry) => {
  const out: Rec = {}
  for (const key of ['id', 'amount', 'currency']) if (entry[key] !== undefined) out[key] = entry[key]
  return out
})
// a refused list of requests: no call at all, one failure that names the input, an evidence that says nothing, nothing of the caller anywhere, and a funds model that concludes nothing from it
async function assertRefused(requestedRefunds: unknown, label: string, extras: Extras = {}): Promise<StripeFundsRead> {
  const world = W()
  const { client } = world.trapClient()
  const result = await read(world, { ...extras, client, request: { ...extras.request, requestedRefunds } })
  assert.deepEqual(world.calls, [], `${label}: a call was made`)
  assert.deepEqual(result.reading.failures, REFUSED_BY_NAME, label)
  assert.deepEqual(result.evidence, NOTHING_READ, label)
  assert.ok(!hasKey(result.evidence, 'requestedRefunds'), `${label}: the refused requests left a key behind`)
  assert.deepEqual(result.reading.structure, { complete: false, parts: { paymentIntent: 'not_read', charge: 'not_read', refunds: 'not_read', disputes: 'not_read', movements: 'not_needed', mode: 'unverified' }, incomplete: ['invalid_input'] }, label)
  assert.equal(result.reading.temporal.observation, 'not_verifiable', label)
  assert.deepEqual([result.reading.temporal.startedAtMs, result.reading.temporal.finishedAtMs, result.reading.temporal.spanMs, result.reading.temporal.withinDeadline], [null, null, null, null], label)
  assert.equal(result.reading.counts.calls, 0, label)
  assertNoCanary(result, label)
  const { retainedIsZero, retainedAtLeast } = await loadP1()
  const p = await position(result.evidence)
  assert.equal(p.certainty, 'uncertain', `${label}: the funds model concluded something from a refused reading`)
  assert.notEqual(retainedIsZero(p), 'yes', label)
  assert.notEqual(retainedAtLeast(p, 1), 'yes', label)
  return result
}
// the copy is what the caller wrote AT THE START: the same words, in a new array of new objects, and the funds model sees the same thing in it that it would see in those words
async function assertTheCopy(result: StripeFundsRead, expected: Rec[], caller: { array: unknown; objects: Rec[] }, label: string) {
  const copy = result.evidence.requestedRefunds
  assert.deepStrictEqual(copy, expected, `${label}: the words as they were at the start`)
  assert.ok(Array.isArray(copy), label)
  assert.notStrictEqual(copy, caller.array, `${label}: the caller's array is in the evidence`)
  for (const object of caller.objects) assert.ok(!(copy as unknown[]).includes(object), `${label}: an object of the caller is in the evidence`)
  assert.deepStrictEqual(await position(result.evidence), await position({ ...result.evidence, requestedRefunds: expected }), `${label}: the funds model sees the words of the start`)
}
// the caller changes EVERYTHING it handed over - the values, the properties, the objects, the array itself. Freezing is irreversible: it is the last thing done to an original, never an intermediate step
function mutateEveryWay(requested: Rec[], freeze: boolean) {
  Object.assign(requested[0], { id: 're_MUTATED', amount: 99999, currency: 'JPY', extra: CANARIES.email })
  delete requested[1].amount
  requested[1].id = null
  requested[2] = { id: 're_REPLACED', amount: 7 }
  requested.push({ id: 're_ADDED', amount: 1 })
  requested.shift()
  requested.reverse()
  requested.length = 0
  if (freeze) Object.freeze(requested)
}
// a client whose n-th call of one method LEAVES at once but whose answer is held back for a macrotask: the reader waits on a Promise that is pending, and the caller changes its values in between
function gatedClient(world: World, hold: { method: Method; nth: number }, whenHeld: () => void): StripeFundsClient {
  const inner = world.client()
  const counts: Partial<Record<Method, number>> = {}
  const gate = (method: Method, started: Promise<unknown>): Promise<unknown> => {
    counts[method] = (counts[method] ?? 0) + 1
    if (method !== hold.method || counts[method] !== hold.nth) return started
    whenHeld()
    return new Promise((resolve, reject) => setImmediate(() => started.then(resolve, reject)))
  }
  return {
    paymentIntents: { retrieve: (id: string, params: { expand: string[] }, options?: ReadRequestOptions) => gate('paymentIntents.retrieve', inner.paymentIntents.retrieve(id, params, options)) },
    refunds: { list: (params: { payment_intent: string; limit: number; starting_after?: string }, options?: ReadRequestOptions) => gate('refunds.list', inner.refunds.list(params, options)) },
    disputes: { list: (params: { payment_intent: string; limit: number; starting_after?: string }, options?: ReadRequestOptions) => gate('disputes.list', inner.disputes.list(params, options)) },
    balanceTransactions: { retrieve: (id: string, params: {}, options?: ReadRequestOptions) => gate('balanceTransactions.retrieve', inner.balanceTransactions.retrieve(id, params, options)) },
  }
}
// an array whose every access is recorded; `length` can be overridden. Only the traps a copy by index and by name could trigger are watched - and none of them may fire but `get`
function watchedArray(target: unknown[], length?: () => unknown) {
  const accessed: string[] = []
  const proxy = new Proxy(target, {
    get(inner, property, receiver) {
      if (typeof property === 'string') accessed.push(property)
      if (property === 'length' && length !== undefined) return length()
      return Reflect.get(inner, property, receiver)
    },
    has(inner, property) { accessed.push(`has:${String(property)}`); return Reflect.has(inner, property) },
    ownKeys(inner) { accessed.push('ownKeys'); return Reflect.ownKeys(inner) },
    getOwnPropertyDescriptor(inner, property) { accessed.push(`descriptor:${String(property)}`); return Reflect.getOwnPropertyDescriptor(inner, property) },
  })
  return { proxy, accessed }
}

const HOLDS: Array<[string, { method: Method; nth: number }]> = [
  ['the first read of the payment', { method: 'paymentIntents.retrieve', nth: 1 }],
  ['the first page of the refunds', { method: 'refunds.list', nth: 1 }],
  ['the first page of the disputes', { method: 'disputes.list', nth: 1 }],
  ['the read of a balance transaction', { method: 'balanceTransactions.retrieve', nth: 1 }],
  ['the closing read of the payment', { method: 'paymentIntents.retrieve', nth: 2 }],
]
test('R1 the caller changes EVERYTHING it handed over while a Promise of Stripe is pending - at once, and at each of the five places a reading waits: what comes back is the copy taken at the start, and nothing the caller does afterwards moves it', async () => {
  const stripeWorld = () => { const world = W(); world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' }); return world }
  // (a) AT ONCE: right after the call, before a single microtask has run. The first call has left and nothing else has - so the copy was taken in the part that precedes the first await
  {
    const world = stripeWorld()
    const requested = requestsOf()
    const expected = copyOf(requested)
    const objects = [...requested]
    const { readStripeFundsEvidence } = await load()
    const pending = readStripeFundsEvidence(world.client() as StripeFundsClient, { paymentIntentId: world.piId, expectedLivemode: world.livemode, requestedRefunds: requested }, { now: world.clock.now })
    assert.equal(world.calls.length, 1, 'the first call has left and nothing else has run')
    mutateEveryWay(requested, true)
    const result = await pending
    await assertTheCopy(result, expected, { array: requested, objects }, 'at once')
    assert.equal(world.calls.length, 5)
  }
  // (b) at each place the reading waits on a pending Promise of Stripe
  for (const [place, hold] of HOLDS) {
    const world = stripeWorld()
    const requested = requestsOf()
    const expected = copyOf(requested)
    const objects = [...requested]
    let reached = 0
    const client = gatedClient(world, hold, () => { reached += 1; mutateEveryWay(requested, true) })
    const result = await read(world, { client, request: { requestedRefunds: requested } })
    assert.equal(reached, 1, `${place}: the reading waited here, once`)
    assert.equal(world.calls.length, 5, `${place}: and went on to the end`)
    assert.equal(result.reading.structure.complete, true, place)
    await assertTheCopy(result, expected, { array: requested, objects }, place)
  }
  // (c) AFTER the reading has returned, on originals that are still mutable (a frozen object cannot be made mutable again: these are new ones): the evidence does not move - and the other way round
  {
    const requested = requestsOf()
    const expected = copyOf(requested)
    const result = await read(stripeWorld(), { request: { requestedRefunds: requested } })
    mutateEveryWay(requested, false)
    assert.deepStrictEqual(result.evidence.requestedRefunds, expected, 'after the return')
    const fresh = requestsOf()
    const again = await read(stripeWorld(), { request: { requestedRefunds: fresh } })
    const copy = again.evidence.requestedRefunds as Rec[]
    copy[0].amount = 424242
    copy.push({ id: 're_X' })
    copy.length = 0
    assert.deepStrictEqual(fresh, requestsOf(), 'what the caller holds is not touched by changes to the evidence')
  }
  // (d) a frozen list of frozen objects is accepted, and copied into plain ones
  {
    const frozenList = Object.freeze(requestsOf().map((entry) => Object.freeze(entry)))
    const result = await read(stripeWorld(), { request: { requestedRefunds: frozenList } })
    assert.deepStrictEqual(result.evidence.requestedRefunds, copyOf(requestsOf()))
    assert.ok(!Object.isFrozen(result.evidence.requestedRefunds))
  }
  // (e) the list is copied BEFORE anything else of the caller's is touched: the client's own properties, the injected clock, the options and the other fields of the request all run code of the caller's (a getter,
  // a function), and each of them changes the caller's list the first time it runs
  for (const where of ['a property of the client', 'the injected clock', 'a property of the options', 'another field of the request']) {
    const world = stripeWorld()
    const requested = requestsOf()
    const expected = copyOf(requested)
    const objects = [...requested]
    let fired = 0
    const change = () => { if (fired === 0) { fired = 1; mutateEveryWay(requested, true) } }
    let client: unknown = world.client()
    const request: Rec = { paymentIntentId: world.piId, expectedLivemode: world.livemode, requestedRefunds: requested }
    const options: Rec = { now: world.clock.now }
    if (where === 'a property of the client') client = new Proxy(world.client(), { get(target, property, receiver) { change(); return Reflect.get(target, property, receiver) } })
    if (where === 'the injected clock') options.now = () => { change(); return world.clock.now() }
    if (where === 'a property of the options') Object.defineProperty(options, 'pageSize', { enumerable: true, get() { change(); return undefined } })
    if (where === 'another field of the request') Object.defineProperty(request, 'paymentIntentId', { enumerable: true, get() { change(); return world.piId } })
    const result = await readRaw(client, request, options)
    assert.equal(fired, 1, `${where}: the caller's code ran`)
    await assertTheCopy(result, expected, { array: requested, objects }, `the caller's code ran in ${where}`)
  }
})

test('R2 an object of the caller that carries more than it was asked for - personal data, secrets, nested objects, a getter that throws - gives up only id, amount and currency: the other properties are not copied, not read, not enumerated, and nothing of them reaches the result', async () => {
  const accessed: string[] = []
  let foreign = 0
  const spied = new Proxy({ id: 're_x2', amount: 6, ...personal() }, {
    get(target, property, receiver) { accessed.push(String(property)); return Reflect.get(target, property, receiver) },
    has(target, property) { accessed.push(`has:${String(property)}`); return Reflect.has(target, property) },
    ownKeys(target) { accessed.push('ownKeys'); return Reflect.ownKeys(target) },
    getOwnPropertyDescriptor(target, property) { accessed.push(`descriptor:${String(property)}`); return Reflect.getOwnPropertyDescriptor(target, property) },
  })
  const plain: Rec = { id: 're_x1', amount: 4, currency: 'eur', ...personal() }
  Object.defineProperty(plain, 'trap', { enumerable: true, get() { foreign += 1; throw new Error(CANARIES.errorText) } })
  const requested = [plain, spied]
  const result = await read(W(), { request: { requestedRefunds: requested } })
  assert.deepStrictEqual(result.evidence.requestedRefunds, [{ id: 're_x1', amount: 4, currency: 'eur' }, { id: 're_x2', amount: 6 }])
  assert.equal(foreign, 0, 'a property the reader does not need was read')
  assert.deepEqual(accessed, ['id', 'amount', 'currency'], 'only the three names, once each, in this order, and never an enumeration or a probe')
  assertNoCanary(result, 'R2')
  const leaked = ['email', 'name', 'phone', 'address', 'street', 'client_secret', 'metadata', 'note', 'receipt_url', 'evidence', 'text', 'nested', 'deep', 'trap', 'extra']
  for (const part of [result.evidence, result.reading]) for (const key of allKeys(part)) assert.ok(!leaked.includes(key), `the key "${key}" of the caller's objects reached the result`)
  const { computeFundsPosition } = await loadP1()
  const touched = new Set<string>()
  computeFundsPosition(recorded(result.evidence, 'evidence', touched))
  assert.ok([...touched].every((path) => allowedReadSet().has(path)), 'the funds model reads nothing of the evidence that is not in the read-set')
})

const NOT_A_LIST: Array<[string, unknown]> = [
  ['null', null], ['a string', 'oops'], ['a number', 7], ['true', true], ['false', false], ['an object', {}], ['an object that looks like an array', { length: 1, 0: { id: 're_x', amount: 1 } }],
  ['a Set', new Set([{ id: 're_x', amount: 1 }])], ['a function', () => []], ['a symbol', Symbol('x')], ['a bigint', BigInt(10)], ['a typed array', new Uint8Array(2)],
  ['an iterable object', { [Symbol.iterator]: () => [][Symbol.iterator]() }], ['an Error', new Error(CANARIES.errorText)],
]
const NOT_AN_OBJECT: Array<[string, unknown]> = [
  ['null', null], ['undefined', undefined], ['a number', 1], ['a string', 're_x'], ['true', true], ['an array', []], ['an array of requests', [{ id: 're_x', amount: 1 }]], ['a function', () => ({})], ['a symbol', Symbol('x')], ['a bigint', BigInt(1)],
]
const WRONG_TYPES: Array<[string, string, unknown]> = [
  ['id', 'a number', 5], ['id', 'true', true], ['id', 'an object', {}], ['id', 'an array', ['re_x']], ['id', 'a function', () => 're_x'], ['id', 'a bigint', BigInt(1)], ['id', 'a symbol', Symbol('x')],
  ['amount', 'a numeric string', '5'], ['amount', 'an empty string', ''], ['amount', 'true', true], ['amount', 'an object', {}], ['amount', 'an array', [5]], ['amount', 'a bigint', BigInt(5)], ['amount', 'a symbol', Symbol('x')], ['amount', 'a function', () => 5],
  ['currency', 'a number', 5], ['currency', 'true', true], ['currency', 'an object', {}], ['currency', 'an array', ['eur']], ['currency', 'a symbol', Symbol('x')],
  // a boxed primitive is an object, not a string or a number: nothing is unwrapped for the caller
  ['id', 'a boxed string', new String('re_x')], ['currency', 'a boxed string', new String('eur')], ['amount', 'a boxed number', new Number(5)],
]
test('R3 anything that is not a list of requests of the right TYPE and STRUCTURE - a container that is not an array, an element that is not an object, a hole, a value of the wrong type, a getter or a Proxy that throws - is refused as a whole: no call, no partial copy, nothing repaired, nothing of it in the report', async () => {
  const hostileArray = (over: Record<string, () => unknown>) => new Proxy([{ id: 're_x', amount: 1 }], {
    get: (target, property, receiver) => (typeof property === 'string' && hasKey(over, property) ? over[property]() : Reflect.get(target, property, receiver)),
  })
  const throwing = (name: string): Rec => { const out: Rec = { id: 're_ok', amount: 1 }; Object.defineProperty(out, name, { enumerable: true, get: boom }); return out }
  const revokedArray = (() => { const { proxy, revoke } = Proxy.revocable([{ id: 're_x', amount: 1 }], {}); revoke(); return proxy })()
  const revokedObject = (() => { const { proxy, revoke } = Proxy.revocable({ id: 're_x', amount: 1 }, {}); revoke(); return proxy })()
  const holes: unknown[] = [{ amount: 1 }]
  holes.length = 3
  holes[2] = { amount: 2 }
  const cases: Array<[string, unknown]> = [
    ...NOT_A_LIST.map(([name, value]): [string, unknown] => [`a container that is ${name}`, value]),
    ...NOT_AN_OBJECT.flatMap(([name, value]): Array<[string, unknown]> => [[`an only element that is ${name}`, [value]], [`a last element that is ${name} (after valid ones: no partial copy)`, [{ id: 're_ok', amount: 1 }, { amount: 2 }, value]]]),
    ['a hole at the start', new Array(1)], ['a hole in the middle', holes], ['a list of holes', new Array(5)],
    ...WRONG_TYPES.flatMap(([key, name, value]): Array<[string, unknown]> => [[`${key} that is ${name}`, [{ id: 're_ok', amount: 1, [key]: value }]], [`${key} that is ${name}, after valid ones`, [{ id: 're_a', amount: 1 }, { id: 're_b', amount: 2 }, { id: 're_c', amount: 3, [key]: value }]]]),
    ['a length that throws', hostileArray({ length: boom })], ['an index that throws', hostileArray({ 0: boom })],
    ['an id that throws', [throwing('id')]], ['an amount that throws', [throwing('amount')]], ['a currency that throws', [throwing('currency')]],
    ['an element that is a Proxy whose every read throws', [new Proxy({}, { get: boom })]], ['a revoked Proxy as the container', revokedArray], ['a revoked Proxy as an element', [revokedObject]],
  ]
  for (const [name, value] of cases) await assertRefused(value, name)
  // the same, with the personal data of the caller in the objects that are refused: nothing of it comes back
  const withData = [{ id: 're_ok', amount: 1, ...personal() }, { id: 7, amount: 1, ...personal() }]
  await assertRefused(withData, 'personal data in a refused list')
})

test('R3b the copy is made by INDEX and by NAME, never through a method of the caller: an array and objects whose methods are traps are read all the same, and no trap is called', async () => {
  const called: string[] = []
  const expected = copyOf(requestsOf())
  const requested = requestsOf()
  const trap = (name: string | symbol) => ({ value: () => { called.push(String(name)); throw new Error(CANARIES.errorText) } })
  // the objects first (the array is still iterable here), then the array itself
  for (const element of requested) for (const name of ['toJSON', 'toString', 'valueOf', 'hasOwnProperty']) Object.defineProperty(element, name, trap(`element.${name}`))
  for (const name of ['map', 'slice', 'forEach', 'reduce', 'filter', 'concat', 'splice', 'push', 'entries', 'keys', 'values', 'at', 'find', 'flat', 'flatMap', 'join', 'toJSON', 'toString', Symbol.iterator]) Object.defineProperty(requested, name, trap(name))
  const result = await read(W(), { request: { requestedRefunds: requested } })
  assert.deepEqual(called, [])
  assert.deepStrictEqual(result.evidence.requestedRefunds, expected)
  assertNoCanary(result, 'R3b')
})

test('R3c TYPE is the reader\'s, DOMAIN is the funds model\'s: a value of the right type but outside the domain (NaN, Infinity, -0, zero, a negative, a fraction, an empty or odd id, an upper-case currency) is neither refused nor repaired nor converted - it arrives exactly, and the model refuses it', async () => {
  const outside: Rec[] = [
    { id: '', amount: -5, currency: 'EUR' }, { amount: 1.5 }, { amount: 0 }, { amount: Number.NaN }, { amount: Number.POSITIVE_INFINITY }, { amount: Number.NEGATIVE_INFINITY }, { amount: -0 },
    { id: ' re_x ', currency: ' eur ' }, { id: 're_ü' }, { id: 'x'.repeat(300) }, { id: 'RE_UPPER', currency: 'Eur' }, { amount: 9007199254740993 }, { amount: 1e21 }, { id: 're_ok', amount: 5, currency: 'eur' },
  ]
  const result = await read(W(), { request: { requestedRefunds: outside } })
  assert.deepStrictEqual(result.evidence.requestedRefunds, copyOf(outside))
  const copy = result.evidence.requestedRefunds as Rec[]
  outside.forEach((entry, index) => { for (const key of ['id', 'amount', 'currency']) if (entry[key] !== undefined) assert.ok(Object.is(copy[index][key], entry[key]), `${index}.${key}`) })
  assert.deepEqual(result.reading.failures, [])
  const p = await position(result.evidence)
  assert.equal(p.certainty, 'uncertain')
  for (const code of ['invalid_amount', 'invalid_identifier']) assert.ok(codes(p).some((entry) => entry.endsWith(`:${code}`)), `the funds model reports ${code}`)
})

test('R3d an object of ANY kind is read for its three names (a Map, a Date, an instance of a class with getters, an empty object): what has no amount is not the reader\'s to refuse - the funds model refuses it - and what has them is copied', async () => {
  class Ask { id = 're_cls'; get amount() { return 4 } }
  const result = await read(W(), { request: { requestedRefunds: [new Map([['id', 're_map']]), new Date(0), {}, new Ask()] } })
  assert.deepStrictEqual(result.evidence.requestedRefunds, [{}, {}, {}, { id: 're_cls', amount: 4 }])
  const p = await position(result.evidence)
  assert.equal(p.certainty, 'uncertain')
  assert.ok(codes(p).some((entry) => entry.endsWith(':invalid_amount')))
})

test('R4 absent is not null: a property that is absent stays absent, null stays null, undefined means "absent", and so for the whole list - a key of the copy exists exactly where there is a value', async () => {
  const given: Rec[] = [{}, { id: null }, { id: undefined }, { amount: null }, { amount: undefined }, { currency: null }, { currency: undefined }, { id: null, amount: null, currency: null }, { id: undefined, amount: undefined, currency: undefined }]
  const result = await read(W(), { request: { requestedRefunds: given } })
  assert.deepStrictEqual(result.evidence.requestedRefunds, [{}, { id: null }, {}, { amount: null }, {}, { currency: null }, {}, { id: null, amount: null, currency: null }, {}])
  for (const entry of result.evidence.requestedRefunds as Rec[]) for (const key of Object.keys(entry)) assert.notEqual(entry[key], undefined, `a key (${key}) whose value is undefined`)
  assert.deepEqual(Object.keys((result.evidence.requestedRefunds as Rec[])[7]), ['id', 'amount', 'currency'], 'the same order of keys for every object')
  const empty = await read(W(), { request: { requestedRefunds: [] } })
  assert.ok(hasKey(empty.evidence, 'requestedRefunds'))
  assert.deepStrictEqual(empty.evidence.requestedRefunds, [])
  for (const [name, extras] of [['not given', {}], ['undefined', { request: { requestedRefunds: undefined } }]] as Array<[string, Extras]>) {
    const absent = await read(W(), extras)
    assert.ok(!hasKey(absent.evidence, 'requestedRefunds') && !('requestedRefunds' in absent.evidence), name)
  }
  // the same container, three ways: absent / undefined are "none given"; null is NOT - it is refused (a refusal never becomes "nothing")
  await assertRefused(null, 'null')
})

test('R5 duplicates, legitimate and conflicting, are KEPT - in the caller\'s order, as copies of their own - and the funds model answers exactly as it would to the caller\'s own list (P1 and P1-bis decide: nothing is de-duplicated here)', async () => {
  const shared = { id: 're_s', amount: 12 }
  const cases: Array<[string, Rec[], (found: string[], p: FundsPosition) => void]> = [
    ['a legitimate duplicate', [{ id: 're_d', amount: 30 }, { id: 're_d', amount: 30 }], (found) => { for (const code of ['note:duplicate_removed', 'uncertainty:refund_requested']) assert.ok(found.includes(code), code) }],
    ['a conflicting duplicate (same id, another amount)', [{ id: 're_d', amount: 30 }, { id: 're_d', amount: 31 }], (found) => assert.ok(found.includes('conflict:conflicting_duplicate'))],
    ['a request that contradicts the refund Stripe lists under that id', [{ id: 're_a', amount: 99 }], (found) => assert.ok(found.includes('conflict:conflicting_duplicate'))],
    ['a request that agrees with the refund Stripe lists', [{ id: 're_a', amount: 20 }], (found) => { for (const code of ['conflict:conflicting_duplicate', 'uncertainty:refund_requested']) assert.ok(!found.includes(code), code) }],
    ['two requests without an id', [{ amount: 5 }, { amount: 5 }], (_found, p) => assert.equal(p.refunds.requestedCents, 10)],
    ['the very same object twice', [shared, shared], (found, p) => { assert.ok(found.includes('note:duplicate_removed')); assert.equal(p.refunds.requestedCents, 12) }],
    ['the same id and amount, the currency written once and not the other time (a refund is in the currency of its payment)', [{ id: 're_d', amount: 30, currency: 'eur' }, { id: 're_d', amount: 30 }], (found) => assert.ok(found.includes('note:duplicate_removed'))],
  ]
  for (const [name, requested, expectFinding] of cases) {
    const world = W()
    world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
    const result = await read(world, { request: { requestedRefunds: requested } })
    const copy = result.evidence.requestedRefunds as Rec[]
    assert.deepStrictEqual(copy, copyOf(requested), name)
    assert.equal(copy.length, requested.length, `${name}: nothing de-duplicated`)
    copy.forEach((entry, index) => assert.ok(!requested.includes(entry), `${name}: ${index} is the caller's object`))
    if (copy.length > 1) assert.equal(new Set(copy).size, copy.length, `${name}: the copies are objects of their own, even when the caller gave the same object twice`)
    const p = await position(result.evidence)
    assert.deepStrictEqual(p, await position({ ...result.evidence, requestedRefunds: requested }), `${name}: the model answers to the copy as to the caller's list`)
    expectFinding(codes(p), p)
  }
})

test('R6 each thing is read ONCE - the property of the request, the length, every index, every name - and what is checked is what is copied: a getter that changes its answer cannot slip a value past the check', async () => {
  const reads: string[] = []
  const counting = (value: unknown, label: string): PropertyDescriptor => ({ enumerable: true, get() { reads.push(label); return value } })
  const element = (n: number): Rec => {
    const out: Rec = {}
    Object.defineProperty(out, 'id', counting(`re_c${n}`, `${n}.id`))
    Object.defineProperty(out, 'amount', counting(n + 1, `${n}.amount`))
    Object.defineProperty(out, 'currency', counting('eur', `${n}.currency`))
    return out
  }
  const array = new Proxy([element(0), element(1)], { get(target, property, receiver) { if (typeof property === 'string') reads.push(`array.${property}`); return Reflect.get(target, property, receiver) } })
  const request: Rec = { paymentIntentId: 'pi_t1', expectedLivemode: false }
  Object.defineProperty(request, 'requestedRefunds', counting(array, 'requestedRefunds'))
  const world = W()
  const result = await readRaw(world.client(), request, { now: world.clock.now })
  assert.deepEqual(reads, ['requestedRefunds', 'array.length', 'array.0', '0.id', '0.amount', '0.currency', 'array.1', '1.id', '1.amount', '1.currency'])
  assert.deepStrictEqual(result.evidence.requestedRefunds, [{ id: 're_c0', amount: 1, currency: 'eur' }, { id: 're_c1', amount: 2, currency: 'eur' }])
  // an object whose id is valid the first time and not the second: the copy is of the FIRST answer, and there is no second one
  let answers = 0
  const flipping: Rec = { amount: 5 }
  Object.defineProperty(flipping, 'id', { enumerable: true, get() { answers += 1; return answers === 1 ? 're_flip' : 7 } })
  const flipped = await read(W(), { request: { requestedRefunds: [flipping] } })
  assert.equal(answers, 1)
  assert.deepStrictEqual(flipped.evidence.requestedRefunds, [{ id: 're_flip', amount: 5 }])
  // the property of the request itself: a list the first time, a string the second
  let asked = 0
  const flippingRequest: Rec = { paymentIntentId: 'pi_t1', expectedLivemode: false }
  Object.defineProperty(flippingRequest, 'requestedRefunds', { enumerable: true, get() { asked += 1; return asked === 1 ? [{ id: 're_ok', amount: 1 }] : 'oops' } })
  const second = W()
  const taken = await readRaw(second.client(), flippingRequest, { now: second.clock.now })
  assert.equal(asked, 1)
  assert.deepStrictEqual(taken.evidence.requestedRefunds, [{ id: 're_ok', amount: 1 }])
  // and the opposite: invalid the first time, valid the second - the first answer is the one that counts
  let again = 0
  const invalidFirst: Rec = { paymentIntentId: 'pi_t1', expectedLivemode: false }
  Object.defineProperty(invalidFirst, 'requestedRefunds', { enumerable: true, get() { again += 1; return again === 1 ? 'oops' : [{ id: 're_ok', amount: 1 }] } })
  const third = W()
  const refused = await readRaw(third.client(), invalidFirst, { now: third.clock.now })
  assert.equal(again, 1)
  assert.deepEqual(refused.reading.failures, REFUSED_BY_NAME)
  assert.deepEqual(third.calls, [])
})

test('R7 nothing is shared and nothing is left behind: two readings started together with the same list get copies of their own; what a reading refused for ANOTHER input received leaves no trace; a reading that refused one list does not affect the next', async () => {
  const shared = requestsOf()
  const [a, b] = await Promise.all([read(W(), { request: { requestedRefunds: shared } }), read(W(), { request: { requestedRefunds: shared } })])
  const listA = a.evidence.requestedRefunds as Rec[]
  const listB = b.evidence.requestedRefunds as Rec[]
  assert.notStrictEqual(listA, listB)
  listA.forEach((entry, index) => { assert.notStrictEqual(entry, listB[index]); assert.ok(!shared.includes(entry)) })
  listA[0].amount = 1
  listA.push({ id: 're_X' })
  assert.deepStrictEqual(listB, copyOf(requestsOf()), 'the other reading did not move')
  assert.deepStrictEqual(shared, requestsOf(), 'the caller\'s list did not move')
  // a valid list, but ANOTHER input is wrong: the reading is refused and the list is not handed back
  const withData = requestsOf().map((entry) => ({ ...entry, ...personal() }))
  const other = await read(W(), { request: { paymentIntentId: 'cs_bad', requestedRefunds: withData } })
  assert.deepEqual(other.reading.failures, [{ call: 'input', kind: 'invalid_input', ref: 'paymentIntentId' }])
  assert.deepEqual(other.evidence, NOTHING_READ)
  assert.ok(!hasKey(other.evidence, 'requestedRefunds'))
  assertNoCanary(other, 'R7')
  // a refused list, then a good one: the second reading is a normal reading
  await assertRefused('oops', 'a list that is refused')
  const good = await read(W(), { request: { requestedRefunds: requestsOf() } })
  assert.deepStrictEqual(good.evidence.requestedRefunds, copyOf(requestsOf()))
  assert.equal(good.reading.structure.complete, true)
})

// ---- R8: compatibility with the funds model and the invariants, on worlds the reader has never seen (a fixed seed range, scalable from outside) ----
function randomRequests(random: Random, world: World): Rec[] {
  const listed = world.refunds.map((refund) => refund.id as string)
  const out: Rec[] = []
  const count = between(random, 0, 4)
  for (let index = 0; index < count; index++) {
    if (index > 0 && random() < 0.2) { out.push(out[between(random, 0, index - 1)]); continue }   // the very same object again
    const entry: Rec = {}
    const idChoice = random()
    const id: unknown = idChoice < 0.25 ? undefined : idChoice < 0.35 ? null : idChoice < 0.6 && listed.length > 0 ? pick(random, listed) : idChoice < 0.7 ? '' : `re_q${between(random, 1, 3)}`
    if (id !== undefined || random() < 0.3) entry.id = id
    const amountChoice = random()
    const amount: unknown = amountChoice < 0.15 ? undefined : amountChoice < 0.22 ? null : amountChoice < 0.8 ? between(random, 1, 40) : pick(random, [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0])
    if (amount !== undefined || random() < 0.3) entry.amount = amount
    const currency: unknown = pick(random, [undefined, undefined, null, 'eur', 'EUR', 'usd'])
    if (currency !== undefined || random() < 0.3) entry.currency = currency
    out.push(entry)
  }
  return out
}
test('R8 (fixed seeds, coherent and dirty worlds, still and moving) the copy of the requests is what the caller wrote at the start; the funds model answers to it as to the caller\'s own list; the reading is fail-closed with the requests present (I1); in a still world the evidence IS the oracle\'s, requests included (I1b\'); nothing leaks', async () => {
  for (let seed = 1; seed <= WORLDS; seed++) {
    const random = mulberry32(seed * 6151)
    const dirty = seed % 4 === 0
    const moving = seed % 3 === 0
    const world = randomWorld(seed, { dirty })
    if (moving) scheduleRandomEvents(world, seed)
    const requested = randomRequests(random, world)
    const expected = copyOf(requested)
    const label = `seed ${seed}${dirty ? ' dirty' : ''}${moving ? ' moving' : ''}`
    const result = await read(world, { request: { requestedRefunds: requested }, options: { pageSize: between(random, 1, 4), maxPages: 50, maxMovementReads: 100 } })
    await assertTheCopy(result, expected, { array: requested, objects: requested }, label)
    // the caller's list was not touched while it was read, so the funds model must answer to the copy exactly as it answers to the caller's own array
    assert.deepStrictEqual(await position(result.evidence), await position({ ...result.evidence, requestedRefunds: requested }), `${label}: the copy and the caller's list`)
    const p = await position(result.evidence)
    if (!isClean(result)) assert.equal(p.certainty, 'uncertain', `${label}: ${JSON.stringify(result.reading.structure.incomplete)} ${result.reading.temporal.observation}`)
    assertFailClosed(result, label)
    if (!moving && !dirty) {
      assert.equal(result.reading.structure.complete, true, label)
      assert.deepStrictEqual(result.evidence, { ...expectedFromOracle(world.oracleRaw()), requestedRefunds: expected }, label)
    }
    assertNoCanary(result, label)
    assert.deepEqual(world.mutationAttempts, [], label)
  }
})

test('R9 at most a thousand requests (a protection of resources, not a financial threshold): exactly a thousand are copied whole; one more is refused - before a single element is read, without a call, without a partial copy and without anything of the caller coming back; a pathological length is refused the same way', async () => {
  const listOf = (count: number): Rec[] => Array.from({ length: count }, (_, index) => ({ id: `re_l${index}`, amount: 1 + (index % 50), ...personal() }))
  // exactly the limit: taken whole
  const atLimit = listOf(REQUESTED_LIMIT)
  const taken = await read(W(), { request: { requestedRefunds: atLimit } })
  assert.equal((taken.evidence.requestedRefunds as Rec[]).length, REQUESTED_LIMIT)
  assert.deepStrictEqual(taken.evidence.requestedRefunds, copyOf(atLimit))
  assert.equal(taken.reading.structure.complete, true)
  assertNoCanary(taken, 'at the limit')
  // one over, plain and watched: refused, and the reader asked for the length ONCE and read no element
  const over = listOf(REQUESTED_LIMIT + 1)
  await assertRefused(over, 'one over the limit')
  const watched = watchedArray(over)
  await assertRefused(watched.proxy, 'one over the limit, watched')
  assert.deepEqual(watched.accessed, ['length'], 'the length once and nothing else: no element, no key, no probe')
  // no partial copy: a thousand where the last one is not an object
  await assertRefused([...atLimit.slice(0, REQUESTED_LIMIT - 1), null], 'the last of a thousand is not valid')
  // a pathological length: sparse and enormous, or a length that is not a length
  await assertRefused(new Array(2 ** 32 - 1), 'a sparse array of 4294967295 places')
  const lengths: Array<[string, unknown]> = [
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['2^32', 2 ** 32], ['1e21', 1e21], ['Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY], ['NaN', Number.NaN], ['-1', -1],
    ['1.5', 1.5], ['a numeric string', '3'], ['null', null], ['undefined', undefined], ['a bigint', BigInt(3)], ['an object', {}], ['true', true],
  ]
  for (const [name, length] of lengths) {
    const hostile = watchedArray([{ id: 're_x', amount: 1 }], () => length)
    await assertRefused(hostile.proxy, `a length that is ${name}`)
    assert.deepEqual(hostile.accessed, ['length'], `${name}: the length once and nothing else`)
  }
  const throwing = watchedArray([], boom)
  await assertRefused(throwing.proxy, 'a length that throws')
  assert.deepEqual(throwing.accessed, ['length'])
  // a Proxy of a good size with every access controlled: the length, then each index - once, in order, nothing else
  const fine = watchedArray([{ id: 're_a', amount: 1 }, { id: 're_b', amount: 2 }, { amount: 3 }])
  const copied = await read(W(), { request: { requestedRefunds: fine.proxy } })
  assert.deepEqual(fine.accessed, ['length', '0', '1', '2'])
  assert.deepStrictEqual(copied.evidence.requestedRefunds, [{ id: 're_a', amount: 1 }, { id: 're_b', amount: 2 }, { amount: 3 }])
  // the limit is no parameter and nothing exported: the surface is unchanged (A5) and a option of that name is not read
  const noise = await read(W(), { options: { maxRequestedRefunds: 5 } })
  assert.deepEqual(noise.reading.failures, [])
})

test('R10 the types and the runtime agree: `requestedRefunds` is OPTIONAL in the output and its absence is REAL - no key, not a key whose value is undefined - whatever the way it is absent; `input` and `invalid_input` are in the types of the report; the output is still the funds model\'s evidence', async () => {
  assert.equal(requestedRefundsIsOptional, true)
  const everyWayToBeAbsent: Array<[string, () => Promise<StripeFundsRead>]> = [
    ['not given', () => read(W())],
    ['undefined', () => read(W(), { request: { requestedRefunds: undefined } })],
    ['refused', () => assertRefused('oops', 'refused')],
    ['refused for another input', () => read(W(), { request: { paymentIntentId: 7, requestedRefunds: requestsOf() } })],
    ['no call possible (a clock that gives no reading)', () => read(W(), { options: { now: () => Number.NaN }, request: { requestedRefunds: requestsOf() } })],
    ['an unforeseen failure with none given (a request that cannot even be looked at)', () => {
      const { proxy, revoke } = Proxy.revocable({}, {})
      revoke()
      const world = W()
      return readRaw(world.client(), proxy, { now: world.clock.now })
    }],
  ]
  for (const [name, run] of everyWayToBeAbsent) {
    const { evidence, reading } = await run()
    assert.ok(!hasKey(evidence, 'requestedRefunds'), `${name}: a key`)
    assert.ok(!('requestedRefunds' in evidence), `${name}: a key in the prototype chain`)
    assert.ok(!Object.keys(evidence).includes('requestedRefunds') && !Object.getOwnPropertyNames(evidence).includes('requestedRefunds'), name)
    assert.deepEqual(Object.keys(evidence).sort(), ['charge', 'disputes', 'paymentIntent', 'refunds'], name)
    if (name.startsWith('an unforeseen failure')) assert.deepEqual(reading.structure.incomplete, ['reader_error'], name)
  }
  // present exactly when a list was given and the reading was not refused - empty or not
  const given = await read(W(), { request: { requestedRefunds: [] } })
  assert.ok(hasKey(given.evidence, 'requestedRefunds') && Array.isArray(given.evidence.requestedRefunds))
  const halfway = W()
  halfway.fault('refunds.list', 1, fail.sdk(sdkErrors.rateLimit))
  const failed = await read(halfway, { request: { requestedRefunds: requestsOf() } })
  assert.deepStrictEqual(failed.evidence.requestedRefunds, copyOf(requestsOf()), 'a reading that could not finish keeps the list that was given')
  // what the report says about a refusal is typed
  const refusal: ReadCall = (await assertRefused([null], 'typed')).reading.failures[0].call
  const kind: ReadFailureKind = (await assertRefused([null], 'typed')).reading.failures[0].kind
  assert.deepEqual([refusal, kind], aRefusalIsReportableByTheTypes)
  // and the output is the funds model's evidence, with and without the list
  const evidence: FundsEvidence = (await read(W(), { request: { requestedRefunds: requestsOf() } })).evidence
  assert.equal((await position(evidence)).certainty, 'uncertain')
  assert.equal(typeof aCopyOfTheRequestsIsEvidence(copyOf(requestsOf()), evidenceWithoutRequests), 'object')
})

test('R11 numbers JSON cannot carry: the reader hands back NaN, Infinity, -Infinity and -0 exactly as the caller wrote them (Object.is) - JSON would write them as null, null, null and 0 - and the funds model reaches no favourable conclusion from any of them; a JSON image of the evidence is never the source of a financial conclusion', async () => {
  const { retainedIsZero, retainedAtLeast } = await loadP1()
  // what JSON does with them is verified here, not assumed
  assert.equal(JSON.stringify([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]), '[null,null,null,0]')
  assert.equal(JSON.stringify({ amount: Number.NaN }), '{"amount":null}')
  assert.ok(!Object.is(JSON.parse(JSON.stringify(-0)), -0) && Object.is(JSON.parse(JSON.stringify(-0)), 0), '-0 comes back from JSON as 0')
  const baseline = await position((await read(W())).evidence)
  const awkward: Array<[string, number]> = [['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY], ['-0', -0]]
  for (const [name, amount] of awkward) {
    for (const requested of [[{ id: 're_awk', amount }], [{ amount }], [{ id: 're_ok', amount: 5 }, { id: 're_awk', amount, currency: 'eur' }]]) {
      const result = await read(W(), { request: { requestedRefunds: requested } })
      const copy = result.evidence.requestedRefunds as Rec[]
      assert.ok(Object.is(copy[copy.length - 1].amount, amount), `${name}: the reader keeps it exactly`)
      const image = JSON.parse(JSON.stringify(result.evidence))
      assert.ok(!Object.is(image.requestedRefunds[copy.length - 1].amount, amount), `${name}: a JSON image of the evidence is NOT a lossless copy of it`)
      const p = await position(result.evidence)
      assert.equal(p.certainty, 'uncertain', `${name}: no proven position from it`)
      assert.ok(codes(p).includes('conflict:invalid_amount'), `${name}: the model refuses the amount`)
      assert.equal(await moreFavourable(p, baseline), false, `${name}: more favourable than the same reading without the request`)
      assert.notEqual(retainedIsZero(p), 'yes', name)
      assert.notEqual(retainedAtLeast(p, 1), 'yes', name)
      assert.ok(p.retainedLowerCents <= baseline.retainedLowerCents, `${name}: a higher lower bound`)
    }
  }
})

// =====================================================================================================================================================================
// N. Contract and documentation
// =====================================================================================================================================================================
test('N3 the documentation of the package exists and names every limit the reader says nobody verifies: docs/VERIFICA-4.6.md has the section S6a.22 and each code of FUNDS_READ_NOT_VERIFIED is in it', async () => {
  const { FUNDS_READ_NOT_VERIFIED } = await load()
  const doc = readSource('docs/VERIFICA-4.6.md')
  const at = doc.search(/^## S6a\.22\b/m)
  assert.ok(at >= 0, 'the section S6a.22 is missing')
  const section = doc.slice(at)
  for (const code of FUNDS_READ_NOT_VERIFIED) assert.ok(section.includes(code), `S6a.22 does not name ${code}`)
})

// =====================================================================================================================================================================
// L. No network, no real key - the last test of the file: every attempt of the whole file was refused and recorded, and the refusal itself is proved effective
// =====================================================================================================================================================================
test('L1 CONTROL: the refusal works - an attempt at a reserved host is refused and recorded', async () => {
  const { attempts } = await withNetworkBlocked(async () => {
    for (const attempt of [() => http.get('http://control.invalid/'), () => https.request('https://control.invalid/'), () => net.connect(1, 'control.invalid'), () => (globalThis as any).fetch('https://control.invalid/')]) {
      try { await attempt() } catch { /* refused: that is the point */ }
    }
  })
  assert.equal(attempts.length, 4)
})

test('L2 no real key and no secret in the tests of the package: the only Stripe key in them is the fictitious one, and no webhook secret or live key appears', () => {
  const texts = [readSource('tests/stripe-funds-reader.test.ts'), readSource('tests/_fake-stripe-funds.ts')]
  const keys = new Set(texts.flatMap((text) => [...text.matchAll(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g)].map((match) => match[0])))
  assert.deepEqual([...keys], [FAKE_KEY])
  for (const text of texts) assert.ok(!/whsec_[A-Za-z0-9]/.test(text) && !/\b(?:sk|rk|pk)_live_[A-Za-z0-9]/.test(text))
})

test('L3 THE WHOLE FILE ran with every connection refused: not one attempt was made (http, https, net, fetch)', () => {
  restoreNetwork()
  assert.deepEqual(NETWORK_ATTEMPTS, [])
})
