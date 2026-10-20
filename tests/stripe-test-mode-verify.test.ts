// Step 4.6, S6 (P0) - scripts/stripe-test-mode-verify.ts, proved OFFLINE: no network, no Stripe key, no Stripe call - not even in Test Mode.
//
// The script is run by the OWNER, later, with a Stripe TEST key. Here it runs against a FAKE Stripe written in this file. The fake plays what the plan ASSUMES Stripe does (and,
// with its switches, what would CONTRADICT it), so these tests prove the SCRIPT: that it refuses a bad key, reads no file, opens no connection in a dry run, stays inside its
// declared maxima, stops on a live-mode object, cleans up only what is allowed, reports every fact, and never writes a secret. They prove NOTHING about Stripe itself: every fact
// the fake "confirms" is SIMULATED. The real answers come only from the owner's run (docs/STRIPE-TEST-MODE-S6.md).
import {
  BUDGET, CLEANUP_OUTCOMES, FACTS, FACT_IDS, Gate, BudgetError, assertCleanReport, errorFacts, main, parseArgs, planLines, redact, refuseKey, refuseReportDir, run,
  type Options, type Report,
} from '../scripts/stripe-test-mode-verify'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const FAKE_KEY = 'sk_test_FAKEOFF1234'
const PINNED = '2099-01-01.test'

// ---- a virtual clock ----------------------------------------------------------------------------------------------------------------------------------------------
function clock() {
  let t = 1_800_000_000_000
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

// ---- the fake Stripe ------------------------------------------------------------------------------------------------------------------------------------------------
type Switches = {
  expireCompleteSucceeds?: boolean      // T2 would be contradicted
  hideNewRefundFromTheFirstListReads?: number // T4 / T15 would be contradicted
  idempotencyIgnored?: boolean          // T5 / T17 would be contradicted
  refundDisputedAllowed?: boolean       // T11 would be contradicted
  searchEmptyForTheFirstCalls?: number  // search lags
  rejectEvent?: string                  // T13 would be contradicted
  disputeNeverAppears?: boolean
  liveObjectOn?: string                 // a live-mode object in the answer of this call
  failOn?: string                       // a permission error on this call
  piStatus?: string                     // the status of a payment (e.g. requires_action)
  flagFalseAfterWon?: boolean           // T9 would be contradicted
  secretInAField?: string               // a string that looks like a secret, in a field the script copies into the report as it is (the api_version of the throw-away endpoint)
}
class StripeError extends Error {
  constructor(public type: string, message: string, public code: string | null = null, public statusCode = 400) { super(message) }
}
class FakeStripe {
  calls: string[] = []
  private seq = 0
  sessions = new Map<string, any>()
  intents = new Map<string, any>()
  refundsById = new Map<string, any>()
  disputes = new Map<string, any>()
  endpoints = new Map<string, any>()
  private idem = new Map<string, { fingerprint: string; value: any }>()
  private inFlight = new Set<string>()
  private searchCalls = 0
  private listReadsAfterCreate = 0
  private pollsOfPi = new Map<string, number>()
  constructor(public switches: Switches = {}) {}

  private next(prefix: string) { return `${prefix}_${++this.seq}` }
  private record(name: string) {
    this.calls.push(name)
    if (this.switches.failOn === name) throw new StripeError('StripePermissionError', `This key cannot call ${name}.`, 'permission_error', 403)
  }
  private live(name: string, value: any) { return this.switches.liveObjectOn === name ? { ...value, livemode: true } : value }

  checkout = {
    sessions: {
      create: async (params: any) => {
        this.record('checkout.sessions.create')
        const id = this.next('cs_test')
        const session = { id, object: 'checkout.session', status: 'open', payment_status: 'unpaid', payment_intent: null, url: `https://checkout.stripe.test/c/pay/${id}`, livemode: false, metadata: params.metadata, client_secret: 'cs_test_secret_SHOULD_NEVER_BE_KEPT', customer_details: { email: 'buyer@example.test' } }
        this.sessions.set(id, session)
        return this.live('checkout.sessions.create', { ...session })
      },
      retrieve: async (id: string, params?: any) => {
        this.record('checkout.sessions.retrieve')
        const session = this.sessions.get(id)
        if (!session) throw new StripeError('StripeInvalidRequestError', 'No such session', 'resource_missing', 404)
        const out = { ...session }
        if (params?.expand?.includes('payment_intent') && session.payment_intent) out.payment_intent = { ...this.intents.get(session.payment_intent) }
        return out
      },
      expire: async (id: string) => {
        this.record('checkout.sessions.expire')
        const session = this.sessions.get(id)
        if (!session) throw new StripeError('StripeInvalidRequestError', 'No such session', 'resource_missing', 404)
        if (session.status !== 'open' && !this.switches.expireCompleteSucceeds) throw new StripeError('StripeInvalidRequestError', 'Only an open Checkout Session can be expired.', 'checkout_session_expire_failed')
        session.status = 'expired'
        return { ...session }
      },
    },
  }
  // what the owner does in the browser at the guided step
  payPage(id: string) {
    const session = this.sessions.get(id)
    const piId = this.next('pi_test')
    this.intents.set(piId, { id: piId, object: 'payment_intent', status: 'succeeded', amount: BUDGET.maxAmountCentsPerPayment, currency: 'eur', livemode: false, metadata: {}, latest_charge: { id: this.next('ch_test'), amount_refunded: 0, refunded: false, disputed: false, receipt_url: 'https://pay.stripe.test/receipts/SECRET' } })
    session.status = 'complete'
    session.payment_status = 'paid'
    session.payment_intent = piId
  }

  paymentIntents = {
    create: async (params: any, opts: any) => {
      this.record('paymentIntents.create')
      void opts
      const id = this.next('pi_test')
      const status = this.switches.piStatus ?? 'succeeded'
      const charge: any = { id: this.next('ch_test'), amount_refunded: 0, refunded: false, disputed: false, receipt_url: 'https://pay.stripe.test/receipts/SECRET', billing_details: { email: 'buyer@example.test' }, payment_method_details: { card: { last4: '4242', fingerprint: 'FPRINT' } } }
      const intent = { id, object: 'payment_intent', status, amount: params.amount, currency: params.currency, livemode: false, metadata: params.metadata, payment_method: params.payment_method, client_secret: `${id}_secret_SHOULD_NEVER_BE_KEPT`, latest_charge: charge, _chargeDisputeCard: params.payment_method === 'pm_card_createDispute' }
      this.intents.set(id, intent)
      return this.live('paymentIntents.create', { ...intent })
    },
    retrieve: async (id: string, params?: any) => {
      this.record('paymentIntents.retrieve')
      const intent = this.intents.get(id)
      if (!intent) throw new StripeError('StripeInvalidRequestError', 'No such payment intent', 'resource_missing', 404)
      const polls = (this.pollsOfPi.get(id) ?? 0) + 1
      this.pollsOfPi.set(id, polls)
      const charge = { ...intent.latest_charge }
      // a dispute appears on a dispute-test card a little after the payment
      if (intent._chargeDisputeCard && !this.switches.disputeNeverAppears && polls >= 2 && !intent.latest_charge.dispute) {
        const disputeId = this.next('dp')
        const dispute = { id: disputeId, object: 'dispute', status: 'needs_response', reason: 'fraudulent', amount: intent.amount, currency: intent.currency, livemode: false, charge: intent.latest_charge.id, balance_transactions: [{ id: this.next('txn'), type: 'adjustment', amount: -intent.amount, fee: 1500, net: -intent.amount - 1500, reporting_category: 'dispute', currency: intent.currency }] }
        this.disputes.set(disputeId, dispute)
        intent.latest_charge.dispute = disputeId
        intent.latest_charge.disputed = true
      }
      const expand: string[] = params?.expand ?? []
      const out: any = { ...intent }
      delete out._chargeDisputeCard
      if (expand.some((entry) => entry.startsWith('latest_charge'))) {
        const full = { ...intent.latest_charge }
        if (expand.includes('latest_charge.dispute') && full.dispute) full.dispute = { ...this.disputes.get(full.dispute) }
        out.latest_charge = full
      } else out.latest_charge = charge.id
      return out
    },
    cancel: async (id: string) => {
      this.record('paymentIntents.cancel')
      const intent = this.intents.get(id)
      if (intent.status === 'succeeded') throw new StripeError('StripeInvalidRequestError', 'A succeeded PaymentIntent can not be canceled.', 'payment_intent_unexpected_state')
      intent.status = 'canceled'
      return { ...intent }
    },
    search: async (params: any) => {
      this.record('paymentIntents.search')
      this.searchCalls++
      if (this.searchCalls <= (this.switches.searchEmptyForTheFirstCalls ?? 0)) return { data: [] }
      const match = /'([^']+)'\s*$/.exec(params.query)?.[1]
      return { data: [...this.intents.values()].filter((intent) => intent.metadata?.makerworksVerify === match).map((intent) => ({ id: intent.id })) }
    },
  }

  refunds = {
    create: async (params: any, opts: any) => {
      this.record('refunds.create')
      const intent = this.intents.get(params.payment_intent)
      if (!intent) throw new StripeError('StripeInvalidRequestError', 'No such payment intent', 'resource_missing', 404)
      const key: string = opts?.idempotencyKey
      const fingerprint = JSON.stringify({ pi: params.payment_intent, amount: params.amount })
      if (key && !this.switches.idempotencyIgnored) {
        if (this.inFlight.has(key)) throw new StripeError('StripeIdempotencyError', 'A request with this key is still in progress.', 'idempotency_key_in_use', 409)
        const known = this.idem.get(key)
        if (known) {
          if (known.fingerprint !== fingerprint) throw new StripeError('StripeIdempotencyError', 'Keys for idempotent requests can only be used with the same parameters.', 'idempotency_error', 400)
          return { ...known.value }
        }
        this.inFlight.add(key)
      }
      await Promise.resolve()
      await Promise.resolve()
      if (intent.latest_charge.disputed && !this.switches.refundDisputedAllowed) {
        if (key) this.inFlight.delete(key)
        throw new StripeError('StripeInvalidRequestError', 'The charge has been charged back and can not be refunded.', 'charge_disputed')
      }
      const refund = { id: this.next('re'), object: 'refund', status: 'succeeded', amount: params.amount, currency: intent.currency, payment_intent: params.payment_intent, livemode: false, metadata: params.metadata, receipt_number: 'RCPT-SECRET', created: this.refundsById.size }
      this.refundsById.set(refund.id, refund)
      intent.latest_charge.amount_refunded += params.amount
      intent.latest_charge.refunded = intent.latest_charge.amount_refunded >= intent.amount
      this.listReadsAfterCreate = 0
      if (key) { this.idem.set(key, { fingerprint, value: refund }); this.inFlight.delete(key) }
      return { ...refund }
    },
    list: async (params: any) => {
      this.record('refunds.list')
      this.listReadsAfterCreate++
      const all = [...this.refundsById.values()].filter((refund) => refund.payment_intent === params.payment_intent)
      const hidden = this.listReadsAfterCreate <= (this.switches.hideNewRefundFromTheFirstListReads ?? 0) ? 1 : 0
      return { data: all.slice(0, Math.max(0, all.length - hidden)).map((refund) => ({ ...refund })) }
    },
    retrieve: async (id: string) => {
      this.record('refunds.retrieve')
      return { ...this.refundsById.get(id) }
    },
  }

  disputesApi = {
    update: async (id: string, params: any) => {
      this.record('disputes.update')
      const dispute = this.disputes.get(id)
      const text = params?.evidence?.uncategorized_text
      dispute.status = text === 'winning_evidence' ? 'won' : 'lost'
      if (dispute.status === 'won') dispute.balance_transactions.push({ id: this.next('txn'), type: 'adjustment', amount: dispute.amount, fee: 0, net: dispute.amount, reporting_category: 'dispute_reversal', currency: dispute.currency })
      for (const intent of this.intents.values()) if (intent.latest_charge.dispute === id && dispute.status === 'won' && this.switches.flagFalseAfterWon) intent.latest_charge.disputed = false
      return { ...dispute }
    },
    retrieve: async (id: string) => {
      this.record('disputes.retrieve')
      return { ...this.disputes.get(id) }
    },
  }
  events = {
    list: async () => {
      this.record('events.list')
      return { data: [...this.disputes.values()].flatMap((dispute) => [{ type: 'charge.dispute.created', data: { object: { id: dispute.id } } }, { type: 'charge.dispute.closed', data: { object: { id: dispute.id } } }, { type: dispute.status === 'won' ? 'charge.dispute.funds_reinstated' : 'charge.dispute.funds_withdrawn', data: { object: { id: dispute.id } } }]) }
    },
  }
  webhookEndpoints = {
    create: async (params: any) => {
      this.record('webhookEndpoints.create')
      if (this.switches.rejectEvent && params.enabled_events.includes(this.switches.rejectEvent)) throw new StripeError('StripeInvalidRequestError', `Invalid event type: ${this.switches.rejectEvent}`, 'parameter_invalid_enum')
      const id = this.next('we')
      const endpoint = { id, object: 'webhook_endpoint', enabled_events: params.enabled_events, livemode: false, api_version: this.switches.secretInAField ?? null, secret: 'whsec_SHOULD_NEVER_BE_KEPT0123', lastResponse: { headers: { 'stripe-version': PINNED } } }
      this.endpoints.set(id, endpoint)
      return endpoint
    },
    del: async (id: string) => {
      this.record('webhookEndpoints.del')
      this.endpoints.delete(id)
      return { id, deleted: true }
    },
  }
}
function asClient(fake: FakeStripe) {
  return { checkout: fake.checkout, paymentIntents: fake.paymentIntents, refunds: fake.refunds, disputes: fake.disputesApi, events: fake.events, webhookEndpoints: fake.webhookEndpoints }
}

// ---- running the script against the fake -------------------------------------------------------------------------------------------------------------------------
function options(over: Partial<Options> = {}): Options {
  return { dryRun: false, reportDir: path.join(os.tmpdir(), 'unused'), currency: 'eur', skipGuided: false, refundTestPm: null, runId: 'abcd1234', only: null, yes: true, ...over }
}
async function runFake(switches: Switches = {}, over: Partial<Options> = {}, answers: { guided?: 'pay' | 'skip' | 'nothing' } = { guided: 'pay' }) {
  const fake = new FakeStripe(switches)
  const time = clock()
  const output: string[] = []
  const report = await run(asClient(fake), options(over), {
    now: time.now, sleep: time.sleep, say: (line) => output.push(line),
    prompt: async (question) => {
      const lastSession = [...fake.sessions.keys()].pop() as string
      if (/press Enter/.test(question)) {
        if (answers.guided === 'skip') return 'skip'
        if (answers.guided !== 'nothing') fake.payPage(lastSession)
        return ''
      }
      return 'YES'
    },
  })
  return { fake, report, output }
}
const factOf = (report: Report, id: string) => report.facts.find((fact) => fact.id === id)!

// =====================================================================================================================================================================
// The key and the arguments
// =====================================================================================================================================================================
test('the key: only a Stripe TEST secret key is accepted - live, publishable, webhook, empty and malformed values are refused', () => {
  assert.equal(refuseKey('sk_test_51ABCdefGHI'), null)
  assert.equal(refuseKey('rk_test_51ABCdefGHI'), null)
  for (const bad of [undefined, null, '', 'sk_live_51ABCdefGHI', 'rk_live_51ABCdefGHI', 'pk_test_51ABCdefGHI', 'whsec_51ABCdefGHI', 'sk_test_', 'sk_test_short', 'sk_test_51ABC defGHIjkl', ' sk_test_51ABCdefGHI', 'sk_test_51ABCdefGHI\n', 'Bearer sk_test_51ABCdefGHI']) {
    assert.ok(refuseKey(bad as string), `accepted ${JSON.stringify(bad)}`)
  }
  assert.match(refuseKey('sk_live_51ABCdefGHI') as string, /LIVE/)
})

test('the arguments: unknown options, a bad currency, a bad run id and a payment method that is not a test token are refused; --only takes only known facts', () => {
  assert.ok('options' in parseArgs(['--dry-run', '--currency', 'eur']))
  for (const argv of [['--nope'], ['--currency', 'euro'], ['--run-id', 'x'], ['--run-id', 'a b c d'], ['--refund-test-pm', 'pm_live_123'], ['--refund-test-pm', 'card_4242'], ['--only', 'T99']]) assert.ok('error' in parseArgs(argv), JSON.stringify(argv))
  const parsed = parseArgs(['--only', 't3,T5', '--skip-guided', '--refund-test-pm', 'pm_card_visa_chargeDeclined']) as { options: Options }
  assert.deepEqual(parsed.options.only, ['T3', 'T5'])
  assert.equal(parsed.options.skipGuided, true)
})

test('the report goes outside the repository, in a folder you name', () => {
  assert.ok(refuseReportDir(null, '/work/repo'))
  assert.ok(refuseReportDir('/work/repo/reports', '/work/repo'))
  assert.ok(refuseReportDir('/work/repo', '/work/repo'))
  assert.ok(refuseReportDir('./reports', process.cwd()), 'a relative folder is resolved from where the script runs: here, inside the repository')
  assert.equal(refuseReportDir('/home/owner/stripe-verify', '/work/repo'), null)
  assert.equal(refuseReportDir('/work/repo-reports', '/work/repo'), null, 'a sibling folder whose name starts like the repository is outside it')
})

// =====================================================================================================================================================================
// Nothing is read from a file, nothing else is used from the environment, nothing but the Stripe SDK and node: modules is imported
// =====================================================================================================================================================================
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/stripe-test-mode-verify.ts'), 'utf8')
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
test('the source: no `.env` is read, the only variable it reads is STRIPE_SECRET_KEY, and it imports nothing of the application', () => {
  assert.ok(!/dotenv/i.test(CODE), 'dotenv')
  assert.ok(!/\.env\b/.test(CODE.replace(/process\.env/g, '')), 'a `.env` file name appears in the code')
  const variables = [...CODE.matchAll(/process\.env\.([A-Z0-9_]+)|env\.([A-Z0-9_]+)/g)].map((match) => match[1] ?? match[2])
  assert.deepEqual([...new Set(variables)], ['STRIPE_SECRET_KEY'])
  assert.ok(!/process\.env\[/.test(CODE) && !/process\.env\s*[,)]/.test(CODE), 'the whole environment is read')
  const imports = [...CODE.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((match) => match[1]).sort()
  assert.deepEqual(imports, ['node:crypto', 'node:fs', 'node:path', 'node:readline', 'stripe'])
  assert.ok(!/readFileSync|readFile\(/.test(CODE), 'it reads a file')
})

test('the source: it never deletes what Stripe does not allow to delete, and never creates a customer, product, price, invoice or link', () => {
  const deletions = [...CODE.matchAll(/\.(del|delete)\(/g)].length
  assert.equal(deletions, 1, 'exactly one deletion is allowed: the throw-away webhook endpoint')
  assert.match(CODE, /webhookEndpoints\.del\(/)
  for (const forbidden of ['customers.', 'products.', 'prices.', 'invoices.', 'invoiceItems.', 'paymentLinks.', 'testHelpers', 'subscriptions.', 'accounts.', 'transfers.', 'payouts.', 'refunds.cancel', 'paymentIntents.capture']) {
    assert.ok(!CODE.includes(forbidden), `the script uses ${forbidden}`)
  }
  assert.match(CODE, /maxNetworkRetries: 0/)
})

// =====================================================================================================================================================================
// --dry-run: no connection of any kind
// =====================================================================================================================================================================
async function withNetworkBlocked<T>(work: () => Promise<T>): Promise<{ result: T; attempts: string[] }> {
  const attempts: string[] = []
  const originals = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get, connect: net.connect, createConnection: net.createConnection, fetch: globalThis.fetch }
  const refuse = (name: string) => (...args: unknown[]) => { attempts.push(`${name} ${String(args[0]).slice(0, 60)}`); throw new Error(`network blocked: ${name}`) }
  ;(http as any).request = refuse('http.request'); (http as any).get = refuse('http.get'); (https as any).request = refuse('https.request'); (https as any).get = refuse('https.get')
  ;(net as any).connect = refuse('net.connect'); (net as any).createConnection = refuse('net.createConnection'); (globalThis as any).fetch = refuse('fetch')
  try { return { result: await work(), attempts } } finally {
    ;(http as any).request = originals.httpRequest; (http as any).get = originals.httpGet; (https as any).request = originals.httpsRequest; (https as any).get = originals.httpsGet
    ;(net as any).connect = originals.connect; (net as any).createConnection = originals.createConnection; (globalThis as any).fetch = originals.fetch
  }
}
test('--dry-run: no key needed, no connection opened, no client built, nothing written; it lists the facts, the maxima and what stays in Stripe', async () => {
  let clients = 0
  const written: string[] = []
  const output: string[] = []
  const { result: code, attempts } = await withNetworkBlocked(() => main(['--dry-run', '--run-id', 'abcd1234'], {}, { say: (line) => output.push(line), createClient: () => { clients++; return {} }, writeReport: (file) => { written.push(file) } }))
  assert.equal(code, 0)
  assert.deepEqual(attempts, [])
  assert.equal(clients, 0)
  assert.deepEqual(written, [])
  const text = output.join('\n')
  for (const id of FACT_IDS) assert.ok(text.includes(`${id} `), `${id} is not listed`)
  assert.match(text, /DRY RUN - nothing is sent to Stripe/)
  assert.match(text, new RegExp(`Checkout Sessions: ${BUDGET.checkoutSessions}`))
  assert.match(text, new RegExp(`PaymentIntents: ${BUDGET.paymentIntents}`))
  assert.match(text, new RegExp(`refunds: ${BUDGET.refunds}`))
  assert.match(text, /can not be deleted/)
  assert.match(text, /no automatic retry/)
})

test('--dry-run with a LIVE key in the environment still stops (a mistake is caught before anything else); a test key is fine and is never printed', async () => {
  const output: string[] = []
  assert.equal(await main(['--dry-run'], { STRIPE_SECRET_KEY: 'sk_live_51ABCdefGHI' }, { say: (line) => output.push(line) }), 2)
  assert.match(output.join('\n'), /LIVE key/)
  const quiet: string[] = []
  assert.equal(await main(['--dry-run'], { STRIPE_SECRET_KEY: FAKE_KEY }, { say: (line) => quiet.push(line) }), 0)
  assert.ok(!quiet.join('\n').includes(FAKE_KEY))
})

test('a real run needs a test key, a folder outside the repository and a YES; without them nothing is created and no client is built', async () => {
  let clients = 0
  // (a refusal must come BEFORE the question: if the owner were asked to type YES here, the run would wait on the keyboard - so asking is a failure, not a pause)
  const deps = { say: () => undefined, createClient: () => { clients++; return {} }, repoRoot: '/work/repo', prompt: async (): Promise<string> => { throw new Error('the owner was asked to type YES although the run had to be refused') } }
  assert.equal(await main(['--report-dir', '/tmp/x'], {}, deps), 2, 'no key')
  assert.equal(await main(['--report-dir', '/tmp/x'], { STRIPE_SECRET_KEY: 'pk_test_51ABCdefGHI' }, deps), 2, 'a publishable key')
  assert.equal(await main([], { STRIPE_SECRET_KEY: FAKE_KEY }, deps), 2, 'no report folder')
  assert.equal(await main(['--report-dir', '/work/repo/out'], { STRIPE_SECRET_KEY: FAKE_KEY }, deps), 2, 'a folder inside the repository')
  assert.equal(await main(['--report-dir', '/tmp/x'], { STRIPE_SECRET_KEY: FAKE_KEY }, { ...deps, prompt: async () => 'no' }), 2, 'the owner did not type YES')
  assert.equal(clients, 0, 'a client was built although nothing was allowed to start')
})

// =====================================================================================================================================================================
// A whole run against the fake: facts, budget, objects, clean-up, report
// =====================================================================================================================================================================
test('SIMULATED: a run against a Stripe that behaves as the plan assumes answers every fact once, and the facts it can ask are confirmed', async () => {
  const { report, fake } = await runFake()
  assert.deepEqual(report.facts.map((fact) => fact.id), FACT_IDS, 'every fact has exactly one answer, in order')
  for (const fact of report.facts) assert.ok(['confirmed', 'contradicted', 'not_confirmable'].includes(fact.status), fact.id)
  const expected: Record<string, string> = {
    T1: 'confirmed', T2: 'confirmed', T3: 'confirmed', T4: 'confirmed', T5: 'confirmed', T6: 'not_confirmable', T7: 'confirmed', T8: 'confirmed', T9: 'confirmed', T10: 'confirmed',
    T11: 'confirmed', T12: 'confirmed', T13: 'confirmed', T14: 'not_confirmable', T15: 'confirmed', T16: 'not_confirmable', T17: 'confirmed', T18: 'confirmed',
  }
  assert.deepEqual(Object.fromEntries(report.facts.map((fact) => [fact.id, fact.status])), expected)
  assert.equal(report.summary.confirmed + report.summary.contradicted + report.summary.not_confirmable, 18)
  assert.equal(report.aborted, null)
  assert.equal(report.livemodeSeen, false)
  assert.ok(fake.calls.length > 20)
})

test('SIMULATED: the declared maxima hold - objects, money, calls and time - and no call or object is made outside the plan', async () => {
  const { report, fake } = await runFake({}, { refundTestPm: 'pm_card_visa' })
  assert.ok(report.usage.amountCents <= BUDGET.maxAmountCentsTotal, `money ${report.usage.amountCents}`)
  assert.ok(report.usage.apiCalls <= BUDGET.maxApiCalls, `calls ${report.usage.apiCalls}`)
  assert.ok(report.usage.elapsedMs <= BUDGET.maxRunMs, `time ${report.usage.elapsedMs}`)
  assert.ok(report.usage.created.checkout_session <= BUDGET.checkoutSessions)
  assert.ok(report.usage.created.payment_intent <= BUDGET.paymentIntents, `payment intents ${report.usage.created.payment_intent}`)
  assert.ok(report.usage.created.refund <= BUDGET.refunds, `refunds ${report.usage.created.refund}`)
  assert.ok(report.usage.created.dispute_evidence <= BUDGET.disputeEvidenceSubmissions)
  assert.ok(report.usage.created.webhook_endpoint <= BUDGET.webhookEndpoints)
  // what the fake really received agrees with what the script counted
  assert.equal(fake.calls.length, report.usage.apiCalls)
  assert.equal(fake.calls.filter((name) => name === 'paymentIntents.create').length + 1 /* the guided payment */, report.usage.created.payment_intent, 'the payments created plus the guided one')
  const allowed = new Set(['checkout.sessions.create', 'checkout.sessions.retrieve', 'checkout.sessions.expire', 'paymentIntents.create', 'paymentIntents.retrieve', 'paymentIntents.cancel', 'paymentIntents.search', 'refunds.create', 'refunds.list', 'refunds.retrieve', 'disputes.update', 'disputes.retrieve', 'events.list', 'webhookEndpoints.create', 'webhookEndpoints.del'])
  for (const name of fake.calls) assert.ok(allowed.has(name), `an unexpected call: ${name}`)
  // the plan that --dry-run prints names the same maxima
  assert.match(planLines(options()).join('\n'), new RegExp(`${(BUDGET.maxAmountCentsTotal / 100).toFixed(2)} EUR in total`))
})

test('the gate stops a run BEFORE it would go over a maximum - objects, money per payment, money in total, calls, time', async () => {
  const time = clock()
  const gate = new Gate({}, time.now)
  await gate.call('x', async () => ({}), { creates: 'checkout_session' })
  await gate.call('x', async () => ({}), { creates: 'checkout_session' })
  await assert.rejects(() => gate.call('x', async () => ({}), { creates: 'checkout_session' }), BudgetError)
  await assert.rejects(() => gate.call('x', async () => ({}), { amountCents: BUDGET.maxAmountCentsPerPayment + 1 }), /exceeds/)
  const rich = new Gate({}, time.now)
  for (let i = 0; i < BUDGET.maxAmountCentsTotal / BUDGET.maxAmountCentsPerPayment; i++) await rich.call('p', async () => ({}), { amountCents: BUDGET.maxAmountCentsPerPayment })
  await assert.rejects(() => rich.call('p', async () => ({}), { amountCents: 1 }), /total amount/)
  const busy = new Gate({}, time.now)
  for (let i = 0; i < BUDGET.maxApiCalls; i++) await busy.call('c', async () => ({}))
  await assert.rejects(() => busy.call('c', async () => ({})), /calls/)
  const slow = new Gate({}, time.now)
  await time.sleep(BUDGET.maxRunMs + 1)
  await assert.rejects(() => slow.call('c', async () => ({})), /minutes/)
  // a creation that FAILED is still counted (it may have made the object)
  const failing = new Gate({}, time.now)
  await assert.rejects(() => failing.call('x', async () => { throw new Error('boom') }, { creates: 'payment_intent' }))
  assert.equal(failing.created.payment_intent, 1)
})

test('a live-mode object in ANY answer stops the run on the spot: nothing else is called, the report says so, and the exit code is 3', async () => {
  const { report, fake } = await runFake({ liveObjectOn: 'paymentIntents.create' })
  assert.equal(report.livemodeSeen, true)
  assert.equal(report.aborted, 'livemode')
  assert.ok(!fake.calls.includes('webhookEndpoints.create'), 'the run went on after a live object')
  assert.ok(!fake.calls.includes('paymentIntents.cancel'), 'the clean-up ran after a live object')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-live-'))
  const out: string[] = []
  const live = new FakeStripe({ liveObjectOn: 'checkout.sessions.create' })
  const time = clock()
  const code = await main(['--report-dir', dir, '--yes', '--run-id', 'live0001'], { STRIPE_SECRET_KEY: FAKE_KEY }, { say: (line) => out.push(line), createClient: () => asClient(live), now: time.now, sleep: time.sleep, repoRoot: '/work/repo' })
  assert.equal(code, 3)
  assert.equal(live.calls.length, 1, 'only the call that returned a live object was made')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('no automatic retry: the client is built without a connection and with maxNetworkRetries 0 (see the source test), and a failing call in the gate is one call', async () => {
  const { createRealClient } = await import('../scripts/stripe-test-mode-verify')
  // (Stripe's constructor only stores its settings: it contacts nobody)
  const { result: client, attempts } = await withNetworkBlocked(async () => createRealClient(FAKE_KEY))
  assert.deepEqual(attempts, [])
  assert.ok(client)
  const gate = new Gate({}, clock().now)
  let calls = 0
  await assert.rejects(() => gate.call('x', async () => { calls++; throw new StripeError('StripeConnectionError', 'down') }))
  assert.equal(calls, 1)
  assert.equal(gate.calls.length, 1)
})

// =====================================================================================================================================================================
// Clean-up and the report
// =====================================================================================================================================================================
test('SIMULATED: every object it created is in the report with an observed clean-up outcome; only what Stripe allows was cleaned', async () => {
  const { report, fake } = await runFake({}, { refundTestPm: 'pm_card_visa' })
  assert.ok(report.objects.length >= 10)
  for (const object of report.objects) {
    assert.ok(object.id && object.type && object.step, JSON.stringify(object))
    assert.ok(CLEANUP_OUTCOMES.includes(object.cleanup.outcome), `${object.type} ${object.id}: ${object.cleanup.outcome}`)
  }
  const outcomes = (type: string) => [...new Set(report.objects.filter((object) => object.type === type).map((object) => object.cleanup.outcome))]
  assert.deepEqual(outcomes('refund'), ['remains'], 'a refund can not be deleted: it stays')
  assert.deepEqual(outcomes('webhook_endpoint'), ['deleted'])
  assert.ok(outcomes('checkout_session').every((outcome) => ['expired', 'remains'].includes(outcome)))
  assert.ok(outcomes('payment_intent').every((outcome) => ['remains', 'canceled'].includes(outcome)))
  assert.ok(fake.endpoints.size === 0, 'the throw-away endpoint was not deleted')
  // a payment that SUCCEEDED is never "canceled": it was not even tried
  for (const [id, intent] of fake.intents) if (intent.status === 'succeeded') assert.ok(!report.objects.some((object) => object.id === id && object.cleanup.outcome === 'canceled'))
  assert.ok(!fake.calls.includes('paymentIntents.cancel') || [...fake.intents.values()].some((intent) => intent.status === 'canceled'))
})

test('SIMULATED: a payment that did not succeed is canceled at the end (the only PaymentIntent clean-up there is)', async () => {
  const { report, fake } = await runFake({ piStatus: 'requires_action' })
  assert.ok(fake.calls.includes('paymentIntents.cancel'))
  assert.ok(report.objects.some((object) => object.type === 'payment_intent' && object.cleanup.outcome === 'canceled'))
  assert.equal(factOf(report, 'T3').status, 'not_confirmable', 'a payment that is not succeeded can not be refunded: the question could not be asked')
})

test('every object is tagged with the run id, and the refunds carry our operation id (what the adoption by metadata will look for)', async () => {
  const { fake } = await runFake({}, { runId: 'tagrun01' })
  for (const intent of fake.intents.values()) if (intent.metadata?.makerworksVerify) assert.equal(intent.metadata.makerworksVerify, 'tagrun01')
  for (const session of fake.sessions.values()) assert.equal(session.metadata.makerworksVerify, 'tagrun01')
  for (const refund of fake.refundsById.values()) {
    assert.equal(refund.metadata.makerworksVerify, 'tagrun01')
    if (refund.metadata.step !== 'T11') assert.match(refund.metadata.makerworksOperationId, /^[0-9a-f-]{36}$/)
  }
})

test('the report: the shape, the maxima it was run under, the call log - and nothing secret, in the file or on the screen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-report-'))
  const fake = new FakeStripe()
  const time = clock()
  const out: string[] = []
  const code = await main(['--report-dir', path.join(dir, 'nested'), '--yes', '--run-id', 'report01'], { STRIPE_SECRET_KEY: FAKE_KEY }, {
    say: (line) => out.push(line), createClient: () => asClient(fake), now: time.now, sleep: time.sleep, repoRoot: '/work/repo',
    prompt: async (question) => { if (/press Enter/.test(question)) fake.payPage([...fake.sessions.keys()].pop() as string); return '' },
  })
  assert.equal(code, 0)
  const file = path.join(dir, 'nested', 'stripe-test-mode-verify-report01.json')
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600, `the report is mode ${mode.toString(8)}`)
  assert.equal(fs.statSync(path.join(dir, 'nested')).mode & 0o777, 0o700, 'the folder is for the owner only')
  const json = fs.readFileSync(file, 'utf8')
  const report = JSON.parse(json) as Report
  assert.equal(report.runId, 'report01')
  assert.equal(report.facts.length, 18)
  assert.deepEqual(report.budget, JSON.parse(JSON.stringify(BUDGET)))
  assert.ok(report.calls.length === report.usage.apiCalls)
  // nothing secret, anywhere: the key, the client secrets, the receipt links, the addresses, the card data, the webhook signing secret
  const everything = `${json}\n${out.join('\n')}`
  for (const secret of [FAKE_KEY, 'SHOULD_NEVER_BE_KEPT', 'receipts/SECRET', 'buyer@example.test', 'RCPT-SECRET', '4242', 'FPRINT', 'client_secret', 'receipt_url', 'whsec_']) assert.ok(!everything.includes(secret), `"${secret}" leaked`)
  // the guided payment page address is shown on the screen ONLY, never saved
  assert.ok(out.some((line) => line.includes('checkout.stripe.test/c/pay/')), 'the guided step did not show the payment page')
  assert.ok(!json.includes('checkout.stripe.test'), 'the payment page address was saved')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('redaction and the last check: a key, a client secret, a signing secret and an address are removed from anything shown, and a report that holds one is not written', () => {
  const text = `error with ${FAKE_KEY} and pi_123_secret_abcDEF and whsec_ABCDEF123456 for buyer@example.test and rk_test_ABCDEF123456 and sk_live_ABCDEF123456`
  const clean = redact(text, FAKE_KEY)
  for (const leak of [FAKE_KEY, 'pi_123_secret_abcDEF', 'whsec_ABCDEF123456', 'buyer@example.test', 'rk_test_ABCDEF123456', 'sk_live_ABCDEF123456']) assert.ok(!clean.includes(leak), leak)
  for (const leak of [`{"a":"${FAKE_KEY}"}`, '{"a":"whsec_ABCDEF123456"}', '{"a":"x@y.example"}', '{"receipt_url":"https://x"}', '{"client_secret":"x"}', '{"last4":"4242"}', '{"a":"pi_1_secret_zzz"}']) {
    assert.throws(() => assertCleanReport(leak, FAKE_KEY), /not written/, leak)
  }
  assert.doesNotThrow(() => assertCleanReport(JSON.stringify({ id: 'pi_test_1', amount: 100, status: 'succeeded' }), FAKE_KEY))
  const facts = errorFacts(Object.assign(new Error(`Invalid key ${FAKE_KEY} for buyer@example.test`), { type: 'StripeAuthenticationError', statusCode: 401 }))
  assert.ok(!JSON.stringify(facts).includes(FAKE_KEY) && !JSON.stringify(facts).includes('buyer@'))
})

test('a fake that returns secrets does not make the script save them: if one slipped into the report the file would not be written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-leak-'))
  const fake = new FakeStripe()
  // a step that would put an address into the report through an error message (the script redacts it; this proves the last check holds even if it did not)
  const original = fake.checkout.sessions.create
  fake.checkout.sessions.create = async (params: any) => { const session = await original(params); (session as any).url = 'https://checkout.stripe.test/c/pay/x'; return session }
  const written: string[] = []
  const time = clock()
  const code = await main(['--report-dir', dir, '--yes', '--run-id', 'leak0001', '--skip-guided'], { STRIPE_SECRET_KEY: FAKE_KEY }, {
    say: () => undefined, createClient: () => asClient(fake), now: time.now, sleep: time.sleep, repoRoot: '/work/repo', writeReport: (file, content) => { written.push(file); assertCleanReport(content, FAKE_KEY) },
  })
  assert.equal(code, 0)
  assert.equal(written.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('redact: the key itself is removed from any text whatever its shape, and so is anything that looks like a secret or an address', () => {
  // (the exact-key replacement is the first line of defence; the patterns catch the usual shapes, the exact replacement catches the rest)
  const odd = 'not-a-stripe-shaped-key-0123456789'
  assert.equal(redact(`the call failed with ${odd} in it`, odd), 'the call failed with [key] in it')
  assert.ok(!redact(`bearer ${FAKE_KEY}`, FAKE_KEY).includes(FAKE_KEY))
  const text = redact('whsec_ABC123def456 rk_live_ABC123def456 pi_3Abc_secret_XyZ123 buyer@example.com cs_test_secret_abc', null)
  for (const piece of ['whsec_ABC', 'rk_live_ABC', '_secret_XyZ', 'buyer@', 'cs_test_secret_abc']) assert.ok(!text.includes(piece), `${piece} was left in: ${text}`)
  assert.equal(redact('nothing to hide here'), 'nothing to hide here')
})

test('the last check before the report is written is made by main() itself: a secret-shaped string that slipped into a field the script copies as it is stops the write (exit 1, no file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-last-check-'))
  const written: string[] = []
  const output: string[] = []
  const fake = new FakeStripe({ secretInAField: 'whsec_ABCDEFGH0123' })
  const time = clock()
  const code = await main(['--report-dir', dir, '--yes', '--run-id', 'lastchk1', '--skip-guided'], { STRIPE_SECRET_KEY: FAKE_KEY }, {
    say: (line) => output.push(line), createClient: () => asClient(fake), now: time.now, sleep: time.sleep, repoRoot: '/work/repo',
    writeReport: (file) => { written.push(file) },   // main must NOT get here
  })
  assert.equal(code, 1, output.join('\n'))
  assert.deepEqual(written, [], 'a report that contained a secret-shaped string was written')
  assert.match(output.join('\n'), /NOT written/)
  assert.ok(!output.join('\n').includes('whsec_ABCDEFGH0123'), 'the string was printed')
  assert.deepEqual(fs.readdirSync(dir), [], 'a file was left behind')
  fs.rmSync(dir, { recursive: true, force: true })
})

// =====================================================================================================================================================================
// What a Stripe that does NOT behave as the plan assumes would make the script say (SIMULATED)
// =====================================================================================================================================================================
test('SIMULATED: T2 - if a paid session could be closed, the fact is contradicted; if nobody paid, it is not confirmable; skipping is allowed', async () => {
  assert.equal(factOf((await runFake({ expireCompleteSucceeds: true })).report, 'T2').status, 'contradicted')
  assert.equal(factOf((await runFake({}, {}, { guided: 'nothing' })).report, 'T2').status, 'not_confirmable')
  assert.equal(factOf((await runFake({}, {}, { guided: 'skip' })).report, 'T2').status, 'not_confirmable')
  const skipped = await runFake({}, { skipGuided: true })
  assert.equal(factOf(skipped.report, 'T2').status, 'not_confirmable')
  assert.ok(!skipped.output.some((line) => /press Enter/.test(line)), 'the guided prompt was shown although it was skipped')
  assert.equal(skipped.report.usage.created.checkout_session, 1, 'a skipped guided step creates no second session')
})

test('SIMULATED: T4 / T15 - a refund that is not visible at once is measured and reported as contradicted', async () => {
  const { report } = await runFake({ hideNewRefundFromTheFirstListReads: 3 })
  assert.equal(factOf(report, 'T4').status, 'contradicted')
  assert.equal((factOf(report, 'T4').observed as any).found, 7)
  assert.equal(factOf(report, 'T15').status, 'contradicted')
})

test('SIMULATED: T5 / T17 - a Stripe that ignored idempotency keys would be reported as contradicted (and the app would never repeat a request)', async () => {
  const { report } = await runFake({ idempotencyIgnored: true })
  assert.equal(factOf(report, 'T5').status, 'contradicted')
  assert.equal(factOf(report, 'T17').status, 'contradicted')
})

test('SIMULATED: T5 - the observation for two requests at once is recorded either way', async () => {
  const { report } = await runFake()
  const observed = factOf(report, 'T5').observed as any
  assert.ok(['same_refund_twice', 'one_refund_one_error:idempotency_key_in_use'].includes(observed.concurrentOutcome), observed.concurrentOutcome)
  assert.equal(observed.refundsMadeForTheConcurrentKey, 1)
  assert.equal(observed.sameKeyOtherAmountError.code, 'idempotency_error')
})

test('SIMULATED: T11 - a refund of a disputed charge that Stripe accepts is contradicted; one that it refuses with charge_disputed is confirmed', async () => {
  assert.equal(factOf((await runFake({ refundDisputedAllowed: true })).report, 'T11').status, 'contradicted')
  const refused = factOf((await runFake()).report, 'T11')
  assert.equal(refused.status, 'confirmed')
  assert.equal((refused.observed as any).error.code, 'charge_disputed')
})

test('SIMULATED: T7 / T8 / T9 / T10 - no dispute in time is not confirmable; a flag that goes back to false is contradicted; the withdrawal and the reinstatement are read from the balance transactions', async () => {
  const none = (await runFake({ disputeNeverAppears: true })).report
  for (const id of ['T7', 'T10', 'T8']) assert.equal(factOf(none, id).status, 'not_confirmable', id)
  assert.equal(factOf((await runFake({ flagFalseAfterWon: true })).report, 'T9').status, 'contradicted')
  const normal = (await runFake()).report
  const t8 = factOf(normal, 'T8').observed as any
  assert.equal(t8.lostStatus, 'lost')
  assert.equal(t8.wonStatus, 'won')
  assert.equal(t8.lostHasWithdrawal, true)
  assert.equal(t8.wonHasReinstatement, true)
  assert.deepEqual(t8.eventTypesSeen, ['charge.dispute.closed', 'charge.dispute.created', 'charge.dispute.funds_reinstated', 'charge.dispute.funds_withdrawn'])
  const t7 = factOf(normal, 'T7').observed as any
  assert.equal(t7.withdrawalOfTheDisputedAmountFound, true)
  assert.equal(t7.balanceTransactions[0].fee, 1500, 'the fee is its own number, apart from the withdrawal')
})

test('SIMULATED: T12 - search that lags is still confirmed (it can discover, never prove absence) and the lag is measured; search that does not work is not confirmable', async () => {
  const lagging = factOf((await runFake({ searchEmptyForTheFirstCalls: 2 })).report, 'T12')
  assert.equal(lagging.status, 'confirmed')
  assert.ok((lagging.observed as any).missedOnTheFirstSearch > 0)
  assert.ok((lagging.observed as any).secondsUntilAllSeen >= BUDGET.searchIntervalMs / 1000)
  assert.equal(factOf((await runFake({ searchEmptyForTheFirstCalls: 999 })).report, 'T12').status, 'not_confirmable')
  assert.equal(factOf((await runFake({ failOn: 'paymentIntents.search' })).report, 'T12').status, 'not_confirmable')
})

test('SIMULATED: T13 - an event type Stripe does not accept is contradicted; the signing secret of the endpoint is never kept; the endpoint is deleted', async () => {
  const bad = await runFake({ rejectEvent: 'charge.dispute.funds_reinstated' })
  assert.equal(factOf(bad.report, 'T13').status, 'contradicted')
  const good = await runFake()
  assert.equal(factOf(good.report, 'T13').status, 'confirmed')
  assert.equal((factOf(good.report, 'T13').observed as any).responseApiVersion, PINNED)
  assert.ok(!JSON.stringify(good.report).includes('whsec_'))
  assert.equal(good.fake.endpoints.size, 0)
})

test('SIMULATED: T14 / T16 need a test payment method YOU name; without one they are not confirmable, and with one they are measured', async () => {
  const without = (await runFake()).report
  assert.equal(factOf(without, 'T14').status, 'not_confirmable')
  assert.equal(factOf(without, 'T16').status, 'not_confirmable')
  const withPm = (await runFake({}, { refundTestPm: 'pm_card_visa' })).report
  assert.ok(['confirmed', 'not_confirmable'].includes(factOf(withPm, 'T14').status))
  assert.equal(factOf(withPm, 'T16').status, 'confirmed', 'T16 is a measurement')
  assert.ok(Array.isArray((factOf(withPm, 'T16').observed as any).amountRefundedSeen))
})

test('T6 is never confirmable (the 24-hour retention can not be reproduced in one run) - whatever the fake does', async () => {
  for (const switches of [{}, { idempotencyIgnored: true }, { expireCompleteSucceeds: true }]) assert.equal(factOf((await runFake(switches)).report, 'T6').status, 'not_confirmable')
})

test('a permission error on one call makes the facts that need it not confirmable - the run goes on with the others and says what failed (no secret in it)', async () => {
  const { report } = await runFake({ failOn: 'refunds.create' })
  for (const id of ['T3', 'T4', 'T5', 'T15', 'T17']) assert.equal(factOf(report, id).status, 'not_confirmable', id)
  assert.equal(factOf(report, 'T1').status, 'confirmed')
  assert.equal(factOf(report, 'T13').status, 'confirmed')
  assert.match(JSON.stringify(factOf(report, 'T3').observed), /StripePermissionError|permission_error/)
})

test('--only runs just the facts named, and only the steps that need them', async () => {
  const { report, fake } = await runFake({}, { only: ['T1'] })
  assert.deepEqual(report.facts.map((fact) => fact.id), ['T1'])
  assert.ok(!fake.calls.includes('refunds.create') && !fake.calls.includes('webhookEndpoints.create') && !fake.calls.includes('paymentIntents.create'))
})

// =====================================================================================================================================================================
// The registry and the guide agree
// =====================================================================================================================================================================
test('the facts: exactly T1 to T18, each with what is assumed, how it is asked, and what changes if it is contradicted or can not be confirmed', () => {
  assert.deepEqual(FACT_IDS, Array.from({ length: 18 }, (_, index) => `T${index + 1}`))
  for (const fact of FACTS) {
    for (const field of ['title', 'assumption', 'method', 'ifContradicted', 'ifNotConfirmable'] as const) assert.ok(fact[field].length > 10, `${fact.id}.${field}`)
  }
})

test('the guide (docs/STRIPE-TEST-MODE-S6.md) lists every fact and the same maxima as the script', () => {
  const guide = fs.readFileSync(path.join(process.cwd(), 'docs/STRIPE-TEST-MODE-S6.md'), 'utf8')
  for (const id of FACT_IDS) assert.ok(new RegExp(`\\b${id}\\b`).test(guide), `${id} is not in the guide`)
  for (const number of [BUDGET.maxApiCalls, BUDGET.checkoutSessions, BUDGET.paymentIntents, BUDGET.refunds, BUDGET.disputeEvidenceSubmissions, BUDGET.webhookEndpoints, BUDGET.maxAmountCentsTotal / 100]) {
    assert.ok(guide.includes(String(number)), `the maximum ${number} is not in the guide`)
  }
  for (const outcome of CLEANUP_OUTCOMES) assert.ok(guide.includes(outcome), `the clean-up outcome "${outcome}" is not in the guide`)
  for (const word of ['STRIPE_SECRET_KEY', '--dry-run', '--report-dir', 'rk_test_', 'read -s', 'YES']) assert.ok(guide.includes(word), `${word} is not in the guide`)
})
