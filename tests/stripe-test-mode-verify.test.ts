// Step 4.6, S6 (P0) - scripts/stripe-test-mode-verify.ts, proved OFFLINE: no network, no Stripe key, no Stripe call - not even in Test Mode.
//
// The script is run by the OWNER, later, with a Stripe TEST key. Here it runs against a FAKE Stripe written in this file. The fake plays what the plan ASSUMES Stripe does (and,
// with its switches, what would CONTRADICT it), so these tests prove the SCRIPT: that it refuses a bad key, reads no file, opens no connection in a dry run, stays inside its
// declared maxima, stops on a live-mode object, cleans up only what is allowed, reports every fact, and never writes a secret. They prove NOTHING about Stripe itself: every fact
// the fake "confirms" is SIMULATED. The real answers come only from the owner's run (docs/STRIPE-TEST-MODE-S6.md).
import {
  BUDGET, CLEANUP_OUTCOMES, FACTS, FACT_IDS, Gate, BudgetError, assertCleanReport, errorFacts, main, parseArgs, planLines, redact, refuseKey, refuseReportDir, run,
  type FactResult, type Options, type Report,
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
  // ---- (SP1 correction) what the fake can play so that T8, T16 and T17 can be proved both ways ----
  refundLifecycle?: RefundLifecycle     // the refund of step T14 (the one made with --refund-test-pm) is NOT "succeeded at once": it goes through states, and amount_refunded follows them
  eventsNone?: boolean                  // events.list returns nothing (the events are not seen)
  omitEvents?: Array<{ type: string; dispute: 'lost' | 'won' }>   // an event that is not seen for ONE dispute (the other one still has its own)
  noReinstatementOnWon?: boolean        // the won dispute has no positive balance transaction (T8: the funds part is contradicted)
}
// How a refund can behave in the fake, in terms of what the script reads:
//   initial   the state in the answer of `refunds.create`
//   then      the state it moves to (null = it stays as it is)
//   after     it moves at the Nth read of the kind named by `on`, and that very read already sees the new state
//   on        'refund' (default): a `refunds.retrieve` of this refund; 'amount': a read of the payment (the amount refunded) - the state changes WHILE the amount is read
//   pendingCounted   `amount_refunded` includes a refund that is still pending / requires_action (a succeeded one always counts, a failed or canceled one never does)
type RefundLifecycle = { initial: 'pending' | 'requires_action' | 'failed' | 'succeeded'; then: 'succeeded' | 'failed' | 'canceled' | null; after: number; on?: 'refund' | 'amount'; pendingCounted: boolean }

// A JSON text that does not depend on the order of the keys (Stripe compares the PARAMETERS of a repeated request, not their order)
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).filter((name) => record[name] !== undefined).sort().map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
type RefundRequestLog = { key: string | undefined; params: any; outcome: string }

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
  // every refunds.create the fake received: the key, the parameters as they were sent, and what the fake did with it (created | replayed | refused:<code>)
  refundRequests: RefundRequestLog[] = []
  private lifecycles = new Map<string, { spec: RefundLifecycle; reads: number }>()
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
      // (a payment whose refund has a lifecycle: reading the amount can be the moment its state changes, and the amount is computed from the states)
      if (intent._lifecycle) { this.tickRefundsOf(id, 'amount'); this.recount(intent) }
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
      delete out._lifecycle
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
      // Stripe compares ALL the parameters of a repeated request with the first one - the amount, the reason, the metadata (every key and value), the payment, anything else.
      // The fake used to compare only the payment and the amount, so a repeat with other metadata went through silently (SP1 correction).
      const fingerprint = canonical(params)
      const log = (outcome: string) => this.refundRequests.push({ key, params: structuredClone(params), outcome })
      if (key && !this.switches.idempotencyIgnored) {
        if (this.inFlight.has(key)) { log('refused:idempotency_key_in_use'); throw new StripeError('StripeIdempotencyError', 'A request with this key is still in progress.', 'idempotency_key_in_use', 409) }
        const known = this.idem.get(key)
        if (known) {
          if (known.fingerprint !== fingerprint) { log('refused:idempotency_error'); throw new StripeError('StripeIdempotencyError', 'Keys for idempotent requests can only be used with the same parameters they were first used with.', 'idempotency_error', 400) }
          log('replayed')
          return { ...known.value }
        }
        this.inFlight.add(key)
      }
      await Promise.resolve()
      await Promise.resolve()
      if (intent.latest_charge.disputed && !this.switches.refundDisputedAllowed) {
        if (key) this.inFlight.delete(key)
        log('refused:charge_disputed')
        throw new StripeError('StripeInvalidRequestError', 'The charge has been charged back and can not be refunded.', 'charge_disputed')
      }
      const lifecycle = intent.metadata?.step === 'T14' ? this.switches.refundLifecycle : undefined
      const refund = { id: this.next('re'), object: 'refund', status: lifecycle ? lifecycle.initial : 'succeeded', amount: params.amount, currency: intent.currency, payment_intent: params.payment_intent, livemode: false, metadata: params.metadata, receipt_number: 'RCPT-SECRET', created: this.refundsById.size }
      this.refundsById.set(refund.id, refund)
      if (lifecycle) { this.lifecycles.set(refund.id, { spec: lifecycle, reads: 0 }); intent._lifecycle = true; this.recount(intent) } else {
        intent.latest_charge.amount_refunded += params.amount
        intent.latest_charge.refunded = intent.latest_charge.amount_refunded >= intent.amount
      }
      this.listReadsAfterCreate = 0
      log('created')
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
      const refund = this.refundsById.get(id)
      const lifecycle = this.lifecycles.get(id)
      if (lifecycle && (lifecycle.spec.on ?? 'refund') === 'refund') this.advance(refund, lifecycle)
      if (lifecycle) this.recount(this.intents.get(refund.payment_intent))
      return { ...refund }
    },
  }

  // ---- the lifecycle of a refund (only the refund of step T14 has one, and only when the test asks for it) ----
  private advance(refund: any, lifecycle: { spec: RefundLifecycle; reads: number }) {
    lifecycle.reads++
    if (lifecycle.spec.then && lifecycle.reads >= lifecycle.spec.after) refund.status = lifecycle.spec.then
  }
  private tickRefundsOf(paymentIntentId: string, on: 'refund' | 'amount') {
    for (const refund of this.refundsById.values()) {
      const lifecycle = this.lifecycles.get(refund.id)
      if (refund.payment_intent === paymentIntentId && lifecycle && (lifecycle.spec.on ?? 'refund') === on && on === 'amount') this.advance(refund, lifecycle)
    }
  }
  // amount_refunded follows the states: succeeded counts, pending / requires_action count only if the lifecycle says so, failed / canceled never
  private recount(intent: any) {
    let counted = 0
    for (const refund of this.refundsById.values()) {
      if (refund.payment_intent !== intent.id) continue
      const lifecycle = this.lifecycles.get(refund.id)
      const open = refund.status === 'pending' || refund.status === 'requires_action'
      if (refund.status === 'succeeded' || (open && (lifecycle?.spec.pendingCounted ?? true))) counted += refund.amount
    }
    intent.latest_charge.amount_refunded = counted
    intent.latest_charge.refunded = counted >= intent.amount
  }

  disputesApi = {
    update: async (id: string, params: any) => {
      this.record('disputes.update')
      const dispute = this.disputes.get(id)
      const text = params?.evidence?.uncategorized_text
      dispute.status = text === 'winning_evidence' ? 'won' : 'lost'
      if (dispute.status === 'won' && !this.switches.noReinstatementOnWon) dispute.balance_transactions.push({ id: this.next('txn'), type: 'adjustment', amount: dispute.amount, fee: 0, net: dispute.amount, reporting_category: 'dispute_reversal', currency: dispute.currency })
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
      if (this.switches.eventsNone) return { data: [] }
      // as Stripe does: a dispute announces `created` and `funds_withdrawn` when it opens (the disputed amount leaves at once), and `closed` when it ends - plus `funds_reinstated` if it was won
      return {
        data: [...this.disputes.values()].flatMap((dispute) => {
          const kind: 'lost' | 'won' | null = dispute.status === 'won' ? 'won' : dispute.status === 'lost' ? 'lost' : null
          const types = ['charge.dispute.created', 'charge.dispute.funds_withdrawn', ...(kind ? ['charge.dispute.closed'] : []), ...(kind === 'won' ? ['charge.dispute.funds_reinstated'] : [])]
          return types
            .filter((type) => !(this.switches.omitEvents ?? []).some((omitted) => omitted.type === type && omitted.dispute === kind))
            .map((type) => ({ type, data: { object: { id: dispute.id } } }))
        }),
      }
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
// the parts of a fact (T8, T16): what was confirmed and what was not, one by one
const partsOf = (fact: FactResult) => (((fact as { parts?: unknown }).parts ?? []) as Array<{ part: string; status: string; detail?: string }>)
const partStatus = (fact: FactResult, part: string) => partsOf(fact).find((entry) => entry.part === part)?.status
const worstOf = (statuses: string[]) => (statuses.includes('contradicted') ? 'contradicted' : statuses.includes('not_confirmable') ? 'not_confirmable' : 'confirmed')

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

test('every fact that has parts is exactly as good as its worst part, each part says what it is, and nothing the fake plays makes the report carry what the last check refuses', async () => {
  const scenarios: Switches[] = [{}, { eventsNone: true }, { noReinstatementOnWon: true }, { refundLifecycle: lifecycle('pending', 'failed') }, { refundLifecycle: lifecycle('pending', 'succeeded') }, { failOn: 'events.list' }]
  for (const switches of scenarios) {
    const { report } = await runFake(switches, { refundTestPm: 'pm_card_visa' })
    const withParts = report.facts.filter((fact) => partsOf(fact).length > 0)
    assert.deepEqual(withParts.map((fact) => fact.id), ['T8', 'T16'], 'only the facts with several claims have parts')
    for (const fact of withParts) {
      assert.equal(fact.status, worstOf(partsOf(fact).map((entry) => entry.status)), `${fact.id} ${JSON.stringify(switches)}`)
      for (const entry of partsOf(fact)) assert.ok(['confirmed', 'contradicted', 'not_confirmable'].includes(entry.status) && (entry.detail ?? '').length > 10, `${fact.id}/${entry.part}`)
    }
    assertCleanReport(JSON.stringify(report), FAKE_KEY)
  }
})

test('worst case for the number of calls: a refund that stays pending for the whole window - the run ends by itself inside the declared maximum, no fact is cut short', async () => {
  const { report, fake } = await runFake({ refundLifecycle: lifecycle('pending', null, { after: 99 }) }, { refundTestPm: 'pm_card_visa' })
  assert.equal(report.aborted, null)
  assert.ok(report.usage.apiCalls <= BUDGET.maxApiCalls, `calls ${report.usage.apiCalls}`)
  assert.equal(fake.calls.length, report.usage.apiCalls)
  assert.ok(report.usage.created.refund <= BUDGET.refunds, `refunds ${report.usage.created.refund}`)
  assert.equal(report.facts.length, 18)
  assert.equal(factOf(report, 'T18').status, 'confirmed', 'the clean-up still ran')
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

// =====================================================================================================================================================================
// SP1 correction. The T17 defect: the late repeats of the first refund were sent with metadata.step = "T17" while the first request (T4) had "T4" - the same key with other
// parameters, which Stripe refuses (idempotency_error). The old fake compared only the payment and the amount, so nothing noticed. Now (1) the fake compares EVERYTHING and
// (2) a test reads what the script really sent. T8 and T16 follow: nothing is "confirmed" that was not seen.
// =====================================================================================================================================================================
const without = (record: Record<string, unknown>, name: string) => Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== name))

test('the simulator: a repeated idempotency key is accepted only with EXACTLY the first request - another amount, reason, metadata (one key, one value), payment or extra parameter is refused, as Stripe does', async () => {
  const fake = new FakeStripe()
  const pay = () => fake.paymentIntents.create({ amount: 100, currency: 'eur', metadata: { step: 'T3' }, payment_method: 'pm_card_visa' }, {})
  const pi = await pay()
  const other = await pay()
  const first = { payment_intent: pi.id, amount: 20, reason: 'requested_by_customer', metadata: { makerworksVerify: 'r1', step: 'T4', makerworksOperationId: 'op1' } }
  const created = await fake.refunds.create(first, { idempotencyKey: 'k1' })
  // the very same request - even with the keys written in another order - is the same refund, not a second one
  const again = await fake.refunds.create({ metadata: { makerworksOperationId: 'op1', step: 'T4', makerworksVerify: 'r1' }, reason: 'requested_by_customer', amount: 20, payment_intent: pi.id }, { idempotencyKey: 'k1' })
  assert.equal(again.id, created.id)
  const different: Array<[string, Record<string, unknown>]> = [
    ['another amount', { ...first, amount: 21 }],
    ['another reason', { ...first, reason: 'duplicate' }],
    ['no reason', without(first, 'reason')],
    ['another VALUE in the metadata (what T17 used to send: step "T17" instead of "T4")', { ...first, metadata: { ...first.metadata, step: 'T17' } }],
    ['one more key in the metadata', { ...first, metadata: { ...first.metadata, note: 'x' } }],
    ['one key less in the metadata', { ...first, metadata: without(first.metadata, 'step') }],
    ['no metadata at all', without(first, 'metadata')],
    ['another payment', { ...first, payment_intent: other.id }],
    ['an extra parameter', { ...first, refund_application_fee: true }],
  ]
  for (const [label, params] of different) {
    await assert.rejects(() => fake.refunds.create(params, { idempotencyKey: 'k1' }), (error: any) => error.code === 'idempotency_error' && error.statusCode === 400, label)
  }
  assert.equal(fake.refundsById.size, 1, 'a refused repeat made a refund')
  assert.deepEqual(fake.refundRequests.map((request) => request.outcome), ['created', 'replayed', ...different.map(() => 'refused:idempotency_error')])
  assert.deepEqual(fake.refundRequests[0].params, first, 'the log keeps the parameters as they were sent')
})

test('SIMULATED: T17 - the late repeats are EXACTLY the first request of their key (same parameters, metadata included): "T17" names the result, never a parameter; only the deliberate mismatch of T5 differs', async () => {
  const { report, fake } = await runFake()
  const byKey = new Map<string, RefundRequestLog[]>()
  for (const request of fake.refundRequests) if (request.key) byKey.set(request.key, [...(byKey.get(request.key) ?? []), request])
  const repeated = [...byKey.values()].filter((list) => list.length > 1)
  assert.equal(repeated.length, 3, 'the keys used more than once: the first refund (T4/T17), the repeated one (T5) and the two at once (T5)')
  const differing = repeated.flatMap((list) => list.slice(1).filter((request) => canonical(request.params) !== canonical(list[0].params)))
  assert.equal(differing.length, 1, `requests that are not the first one repeated: ${JSON.stringify(differing.map((request) => request.params.metadata))}`)
  assert.equal(differing[0].params.amount, 11, 'the only request that differs on purpose is the "same key, another amount" of T5')
  assert.equal(differing[0].outcome, 'refused:idempotency_error', 'and it must have been refused')
  // the first refund and its three late repeats: four identical requests, the last three answered as replays
  const first = repeated.find((list) => list[0].params.metadata.step === 'T4')!
  assert.ok(first, 'the first refund (step T4) was not repeated')
  assert.equal(first.length, 4)
  for (const request of first) assert.equal(canonical(request.params), canonical(first[0].params))
  assert.deepEqual(first.map((request) => request.outcome), ['created', 'replayed', 'replayed', 'replayed'])
  assert.ok(!fake.refundRequests.some((request) => request.params.metadata?.step === 'T17'), 'a request carried "T17" as a parameter: T17 names the result, not a parameter')
  const t17 = factOf(report, 'T17')
  assert.equal(t17.status, 'confirmed')
  assert.equal((t17.observed as any).refundsForTheKey, 1)
  assert.equal((t17.observed as any).sameRefundEachTime, true)
  // and a Stripe that ignored the key would still be caught (the check is not made blind by the strict fake)
  assert.equal(factOf((await runFake({ idempotencyIgnored: true })).report, 'T17').status, 'contradicted')
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

// What T8 asks: a LOST dispute leaves a withdrawal, a WON one reinstates the funds, and the events `closed` / `funds_withdrawn` / `funds_reinstated` announce them - each event for ITS
// dispute (lost: closed + funds_withdrawn; won: closed + funds_reinstated). The funds are read from the balance transactions, the events from the list of events. The defect: "confirmed"
// depended on the funds alone, so the events were "confirmed" without ever having been seen (and the events of the two disputes were pooled into one set). Now the status is the worst of
// four parts - outcomes, withdrawal, reinstatement, events - and the report says which part is which.
const ALL_PARTS_OK = { outcomes: 'confirmed', withdrawal_on_lost: 'confirmed', reinstatement_on_won: 'confirmed', events: 'confirmed' }
const FUNDS_OK_EVENTS_NOT = { outcomes: 'confirmed', withdrawal_on_lost: 'confirmed', reinstatement_on_won: 'confirmed', events: 'not_confirmable' }
const CLOSED = 'charge.dispute.closed'
const WITHDRAWN = 'charge.dispute.funds_withdrawn'
const REINSTATED = 'charge.dispute.funds_reinstated'
const T8_CASES: Array<{ name: string; switches: Switches; status: string; parts: Record<string, string>; missing: { lost: string[]; won: string[] }; check?: (observed: any) => void }> = [
  {
    name: 'everything seen: the outcomes, the withdrawal, the reinstatement AND the events, each for its own dispute', switches: {}, status: 'confirmed', parts: ALL_PARTS_OK, missing: { lost: [], won: [] },
    check: (o) => {
      assert.deepEqual(o.eventsSeenByDispute.lost, [CLOSED, 'charge.dispute.created', WITHDRAWN])
      assert.deepEqual(o.eventsSeenByDispute.won, [CLOSED, 'charge.dispute.created', REINSTATED, WITHDRAWN])
      assert.equal(o.eventsReadable, true)
    },
  },
  {
    name: 'no event is seen at all: the funds are confirmed, the events are NOT (the old script said "confirmed" for the whole fact)', switches: { eventsNone: true }, status: 'not_confirmable', parts: FUNDS_OK_EVENTS_NOT,
    missing: { lost: [CLOSED, WITHDRAWN], won: [CLOSED, REINSTATED] }, check: (o) => assert.deepEqual(o.eventTypesSeen, []),
  },
  {
    name: 'one required event is missing for the WON dispute', switches: { omitEvents: [{ type: REINSTATED, dispute: 'won' }] }, status: 'not_confirmable', parts: FUNDS_OK_EVENTS_NOT, missing: { lost: [], won: [REINSTATED] },
  },
  {
    // The WON dispute has its own `funds_withdrawn` (it opened with a withdrawal too), so a set of event types pooled over both disputes still contains `funds_withdrawn`: the pooled check could
    // not see that the LOST dispute never announced its withdrawal.
    name: 'a required event is missing for the LOST dispute while the other dispute has an event of the same type (pooling would hide it)', switches: { omitEvents: [{ type: WITHDRAWN, dispute: 'lost' }] },
    status: 'not_confirmable', parts: FUNDS_OK_EVENTS_NOT, missing: { lost: [WITHDRAWN], won: [] }, check: (o) => assert.ok(o.eventTypesSeen.includes(WITHDRAWN), 'the pooled set still has funds_withdrawn: that is the point'),
  },
  {
    name: '`closed` is missing for the lost dispute', switches: { omitEvents: [{ type: CLOSED, dispute: 'lost' }] }, status: 'not_confirmable', parts: FUNDS_OK_EVENTS_NOT, missing: { lost: [CLOSED], won: [] },
  },
  {
    name: 'the list of events can not be read (permission): the funds are confirmed, the events are not, and the run goes on', switches: { failOn: 'events.list' }, status: 'not_confirmable', parts: FUNDS_OK_EVENTS_NOT,
    missing: { lost: [CLOSED, WITHDRAWN], won: [CLOSED, REINSTATED] }, check: (o) => { assert.equal(o.eventsReadable, false); assert.equal(o.eventsError.code, 'permission_error') },
  },
  {
    name: 'the funds were NOT reinstated on the won dispute: contradicted, whatever the events say', switches: { noReinstatementOnWon: true }, status: 'contradicted',
    parts: { outcomes: 'confirmed', withdrawal_on_lost: 'confirmed', reinstatement_on_won: 'contradicted', events: 'confirmed' }, missing: { lost: [], won: [] },
  },
]
test('SIMULATED: T8 - "confirmed" needs the outcomes, the withdrawal, the reinstatement AND the events of each dispute; events that were not seen leave the fact not confirmable, and the report says which parts were confirmed', async () => {
  for (const scenario of T8_CASES) {
    const { report } = await runFake(scenario.switches)
    const t8 = factOf(report, 'T8')
    const observed = t8.observed as any
    assert.equal(t8.status, scenario.status, `${scenario.name}: ${JSON.stringify(observed)}`)
    assert.deepEqual(Object.fromEntries(partsOf(t8).map((entry) => [entry.part, entry.status])), scenario.parts, `${scenario.name}: the parts`)
    assert.equal(worstOf(partsOf(t8).map((entry) => entry.status)), t8.status, `${scenario.name}: the status is the worst of the parts`)
    assert.deepEqual(observed.eventsMissing, scenario.missing, `${scenario.name}: the events that were not seen, per dispute`)
    scenario.check?.(observed)
    // what the other dispute facts say is not changed by the events
    assert.equal(factOf(report, 'T9').status, 'confirmed', scenario.name)
    if (scenario.status === 'not_confirmable') assert.match(t8.note, /NOT confirmed/, `${scenario.name}: the note must say what was NOT confirmed`)
    if (scenario.status !== 'confirmed') assert.match(t8.note, /confirmed|contradicted|assumed/i)
    assert.equal(report.aborted, null, scenario.name)
  }
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

test('SIMULATED: T14 / T16 need a test payment method YOU name; without one they are not confirmable, and with one that gives only a refund that succeeded at once they are STILL not confirmable', async () => {
  const without = (await runFake()).report
  assert.equal(factOf(without, 'T14').status, 'not_confirmable')
  assert.equal(factOf(without, 'T16').status, 'not_confirmable')
  // The defect: with a test method named and a refund that succeeded at once (nothing pending, nothing failed, nothing canceled) T16 was "confirmed" - an assertion of this very test
  // ("T16 is a measurement"). A measurement that never saw the states it measures confirms nothing.
  const withPm = (await runFake({}, { refundTestPm: 'pm_card_visa' })).report
  assert.equal(factOf(withPm, 'T14').status, 'not_confirmable')
  const t16 = factOf(withPm, 'T16')
  assert.equal(t16.status, 'not_confirmable', JSON.stringify(t16.observed))
  assert.ok(Array.isArray((t16.observed as any).samples))
})

// What T16 asks: does `amount_refunded` include a refund that is still pending / requires_action, and does it go back down when the refund fails or is canceled? To answer, the script must
// have SEEN a refund pending (or requires_action) with the amount read at that moment AND failed (or canceled) with the amount read at that moment. Each amount is bracketed by two reads of
// the refund's state; if the state changed in between, the sample is not used (its amount may belong to the other state).
const lifecycle = (initial: RefundLifecycle['initial'], then: RefundLifecycle['then'], over: Partial<RefundLifecycle> = {}): RefundLifecycle => ({ initial, then, after: 2, pendingCounted: true, ...over })
const T16_CASES: Array<{ name: string; lifecycle?: RefundLifecycle; t14: string; t16: string; missing: string[]; check: (observed: any) => void }> = [
  {
    name: 'a refund that succeeded at once: nothing pending, nothing failed (the old T16 said "confirmed" here)', t14: 'not_confirmable', t16: 'not_confirmable', missing: ['pending_or_requires_action', 'failed_or_canceled'],
    check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, null); assert.equal(o.amountAfterFailure, null); assert.equal(o.wentBackDown, null); assert.equal(o.amountAfterSuccess, 20) },
  },
  {
    name: 'pending, then failed - and the pending refund IS counted in amount_refunded', lifecycle: lifecycle('pending', 'failed'), t14: 'confirmed', t16: 'confirmed', missing: [],
    check: (o) => {
      assert.equal(o.pendingRefundCountedInAmountRefunded, true); assert.equal(o.amountWhilePending, 20); assert.equal(o.amountAfterFailure, 0); assert.equal(o.wentBackDown, true)
      // the sample taken while the state changed (pending before, failed after, the amount still the pending one) exists and was NOT used
      assert.ok(o.samples.some((sample: any) => sample.stable === false && sample.statusBefore === 'pending' && sample.statusAfter === 'failed' && sample.amountRefunded === 20), JSON.stringify(o.samples))
    },
  },
  {
    name: 'pending, then failed - and the pending refund is NOT counted', lifecycle: lifecycle('pending', 'failed', { pendingCounted: false }), t14: 'confirmed', t16: 'confirmed', missing: [],
    check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, false); assert.equal(o.amountWhilePending, 0); assert.equal(o.amountAfterFailure, 0); assert.equal(o.wentBackDown, false) },
  },
  {
    name: 'pending, then canceled (counted)', lifecycle: lifecycle('pending', 'canceled'), t14: 'confirmed', t16: 'confirmed', missing: [],
    check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, true); assert.equal(o.amountAfterFailure, 0); assert.equal(o.wentBackDown, true) },
  },
  {
    name: 'requires_action, then failed (counted)', lifecycle: lifecycle('requires_action', 'failed'), t14: 'confirmed', t16: 'confirmed', missing: [],
    check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, true); assert.equal(o.amountAfterFailure, 0); assert.equal(o.wentBackDown, true) },
  },
  {
    name: 'pending, then SUCCEEDED: half the question (is a pending refund counted?) was answered, the other half (does it go down when one fails?) was not', lifecycle: lifecycle('pending', 'succeeded', { pendingCounted: false }), t14: 'confirmed', t16: 'not_confirmable', missing: ['failed_or_canceled'],
    check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, false); assert.equal(o.amountAfterSuccess, 20); assert.equal(o.amountAfterFailure, null); assert.equal(o.wentBackDown, null) },
  },
  {
    name: 'pending for the whole window (it never ended)', lifecycle: lifecycle('pending', null, { after: 99 }), t14: 'confirmed', t16: 'not_confirmable', missing: ['failed_or_canceled'],
    check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, true); assert.equal(o.samples.length, BUDGET.maxPollAttempts, 'the whole polling window was used and no more') },
  },
  {
    name: 'failed at once: never seen pending', lifecycle: lifecycle('failed', null, { after: 99 }), t14: 'confirmed', t16: 'not_confirmable', missing: ['pending_or_requires_action'],
    check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, null); assert.equal(o.amountAfterFailure, 0); assert.equal(o.wentBackDown, null) },
  },
  {
    // The state changes WHILE the amount is read: the refund was "pending" before and is "failed" after, and the amount is already the failed one (0). Pairing the amount with the
    // state read before would say "a pending refund is not counted" - false, in this fake it is. The sample must be thrown away: pending was never caught, so T16 can not be confirmed
    // and must NOT claim anything about pending refunds.
    name: 'the state changes while the amount is read: that sample must not be used', lifecycle: lifecycle('pending', 'failed', { after: 1, on: 'amount' }), t14: 'confirmed', t16: 'not_confirmable', missing: ['pending_or_requires_action'],
    check: (o) => {
      assert.equal(o.pendingRefundCountedInAmountRefunded, null, 'a claim about pending refunds was made from a sample taken while the state changed')
      assert.equal(o.amountAfterFailure, 0)
      assert.ok(o.samples.some((sample: any) => sample.stable === false && sample.statusBefore === 'pending' && sample.statusAfter === 'failed' && sample.amountRefunded === 0), JSON.stringify(o.samples))
    },
  },
]
test('SIMULATED: T16 - confirmed ONLY if the refund was caught pending (or requires_action) AND failed (or canceled), each with the amount read at that moment; what was seen is reported, what was not makes it not confirmable', async () => {
  for (const scenario of T16_CASES) {
    const { report } = await runFake(scenario.lifecycle ? { refundLifecycle: scenario.lifecycle } : {}, { refundTestPm: 'pm_card_visa' })
    const t16 = factOf(report, 'T16')
    const observed = t16.observed as any
    assert.equal(t16.status, scenario.t16, `${scenario.name}: ${JSON.stringify(observed)}`)
    assert.equal(factOf(report, 'T14').status, scenario.t14, `${scenario.name}: T14 (it must not change)`)
    assert.deepEqual(observed.missing, scenario.missing, `${scenario.name}: what was not seen`)
    assert.equal(partStatus(t16, 'pending_or_requires_action'), scenario.missing.includes('pending_or_requires_action') ? 'not_confirmable' : 'confirmed', `${scenario.name}: part 1`)
    assert.equal(partStatus(t16, 'failed_or_canceled'), scenario.missing.includes('failed_or_canceled') ? 'not_confirmable' : 'confirmed', `${scenario.name}: part 2`)
    assert.equal(worstOf(partsOf(t16).map((entry) => entry.status)), t16.status, `${scenario.name}: the status is the worst of the parts`)
    assert.ok(t16.status !== 'contradicted', 'T16 is a measurement: it is never contradicted')
    scenario.check(observed)
    assert.equal(report.aborted, null, scenario.name)
    assert.ok(report.usage.apiCalls <= BUDGET.maxApiCalls, `${scenario.name}: ${report.usage.apiCalls} calls`)
  }
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
