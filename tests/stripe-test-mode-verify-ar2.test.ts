// Step 4.6, S6 (SP1-quater) - the AR-2 protocol of scripts/stripe-test-mode-verify.ts: the ASYNCHRONOUS REFUNDS, proved OFFLINE. No network, no Stripe key, no Stripe call - not even in Test Mode.
//
// AR-2 is a second protocol of the same script. It is started ONLY with --protocol ar2: a plain start runs SP1 (T1-T18) exactly as before (tests/stripe-test-mode-verify.test.ts). It has two
// scenarios, independent of each other (own payment, own refund, own verdicts), after Stripe's own table of test payment methods (https://docs.stripe.com/testing#refunds):
//   A  pm_card_pendingRefund   the refund starts `pending` and later becomes `succeeded`
//   B  pm_card_refundFail      the refund starts `succeeded` and later becomes `failed`
// and six facts: T13B (the refund event types can be SUBSCRIBED), T14A and T14B (the states of the refund), T16A and T16B (what `amount_refunded` says in those states) and T19 (the events
// Stripe really GENERATED, and when).
//
// The fake below plays what Stripe DOCUMENTS and, with its switches, what it might do otherwise: transitions that are immediate, late or never; a state that changes while the amount is read;
// a `failure_balance_transaction` that is null, absent or unreadable; events that are missing, late or unreadable. These tests prove the SCRIPT - that it asks the questions in the right
// way, stays inside the declared maxima, stops when it must and never writes a secret. They prove NOTHING about Stripe: every fact the fake "confirms" is SIMULATED. The real answers come
// only from the owner's run (docs/STRIPE-TEST-MODE-S6.md, section 11).
//
// SP1-quater-bis - three corrections, each proved here BEFORE the script was changed (red, then green):
//   1. a MEASURE of the amount refunded (T16A, T16B) is confirmed only with at least TWO stable readings that agree and were taken at least `confirmAfterMs` (5 seconds) apart; one reading, two in the same
//      instant (or closer than five seconds) or two that disagree leave it NOT confirmed, with the readings that were taken kept in the report;
//   2. a real run of AR-2 ALWAYS asks for the word AR-2: `--yes` is refused with `--protocol ar2` (SP1 keeps it exactly as it was);
//   3. the scan for live-mode objects looks at EVERY element of a list (AR-2 reads lists of 100 events), not at the first twenty.
//
// The script is reached through a namespace import on purpose: written BEFORE the script was changed, each of these tests fails on its own (and the whole file still loads).
import * as script from '../scripts/stripe-test-mode-verify'
import type { AsyncRefundObservation, AsyncRefundSample, EventsRecord, FactResult, Options, Report } from '../scripts/stripe-test-mode-verify'
import { stripComments } from './_source-scan'
import Stripe from 'stripe'
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
const TOKEN_A = 'pm_card_pendingRefund'
const TOKEN_B = 'pm_card_refundFail'

// ---- a virtual clock ----------------------------------------------------------------------------------------------------------------------------------------------
function clock() {
  let t = 1_800_000_000_000
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}
type Clock = ReturnType<typeof clock>

// ---- errors exactly as the Stripe SDK builds them (nothing is invented; nothing touches the network) ------------------------------------------------------------------------
const sdkError = {
  api: () => Stripe.errors.StripeError.generate({ type: 'api_error', message: 'An unknown error occurred.', statusCode: 500 }),
  connection: () => new Stripe.errors.StripeConnectionError({ message: 'An error occurred with our connection to Stripe.' } as any),
  permission: () => new Stripe.errors.StripePermissionError({ type: 'invalid_request_error', message: 'The provided key does not have the required permissions.', statusCode: 403 }),
  authentication: () => new Stripe.errors.StripeAuthenticationError({ type: 'authentication_error', message: 'Invalid API Key provided.', statusCode: 401 }),
  rateLimit: () => new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: 'Too many requests hit the API too quickly.', statusCode: 429 }),
  notFound: () => Stripe.errors.StripeError.generate({ type: 'invalid_request_error', code: 'resource_missing', message: 'No such object.', statusCode: 404 }),
  invalidRequest: () => Stripe.errors.StripeError.generate({ type: 'invalid_request_error', message: 'The request was unacceptable.', statusCode: 400 }),
  invalidRequestAbout: (param: string) => Stripe.errors.StripeError.generate({ type: 'invalid_request_error', message: 'The request was unacceptable.', param, statusCode: 400 }),
  eventTypeRefused: (event: string) => Stripe.errors.StripeError.generate({ type: 'invalid_request_error', message: `An event type of the endpoint is not accepted: ${event}`, param: 'enabled_events', statusCode: 400 }),
  idempotencyMismatch: () => Stripe.errors.StripeError.generate({ type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.', statusCode: 400 }),
}
type FailError = 'permission' | 'api' | 'connection' | 'authentication' | 'rate_limit'
const FAIL_ERRORS: Record<FailError, () => Error> = { permission: sdkError.permission, api: sdkError.api, connection: sdkError.connection, authentication: sdkError.authentication, rate_limit: sdkError.rateLimit }

// ---- the fake Stripe: the refunds of AR-2, in time ------------------------------------------------------------------------------------------------------------------------
type Scenario = 'A' | 'B'
type RefundState = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | 'a_state_nobody_knows'
// How a refund behaves: the state in the answer that creates it, and the moves it makes later (each at a time counted from its creation, on the virtual clock).
type Plan = { initial: RefundState; moves: Array<{ afterMs: number; to: RefundState }> }
const DEFAULT_A: Plan = { initial: 'pending', moves: [{ afterMs: 40_000, to: 'succeeded' }] }
const DEFAULT_B: Plan = { initial: 'succeeded', moves: [{ afterMs: 90_000, to: 'failed' }] }
type FailSpec = { call: string; scenario?: Scenario; error: FailError; times: number; skip?: number }
type StopAt = { call: string; stop: 'livemode' | 'budget' | 'clock'; nth?: number }
type Switches = {
  planA?: Plan
  planB?: Plan
  pendingCounted?: boolean                                   // `amount_refunded` includes a refund that is pending (default: yes)
  failureDropsTheAmount?: boolean                            // `amount_refunded` goes back down when a refund fails (default: yes)
  failureReason?: string | null | 'absent'                   // `failure_reason` of a failed refund (default: 'unknown', a value Stripe documents)
  failureBalanceTransaction?: 'present' | 'null' | 'absent'  // `failure_balance_transaction` is nullable: present, null, or left out
  refundBalanceTransaction?: 'present' | 'null' | 'absent'   // `balance_transaction` of the refund itself (a pending refund has none yet): present, null, or left out
  balanceTransactionError?: FailError | 'not_found'          // the read of that balance transaction fails
  pendingReason?: string | 'absent'                          // `pending_reason` of a pending refund
  events?: 'documented' | 'none'                             // the events Stripe generates (default: the documented ones)
  omitEvents?: string[]                                      // event types that are never generated
  deprecatedUpdated?: boolean                                // also `charge.refund.updated` at every move
  lagEventsForFirstReads?: number                            // the first N reads of the list do not show the events of the moves yet
  eventsPadding?: { total: number; liveIndex?: number; liveOnRead?: number } // `events.list` answers with exactly `total` events (the real ones first, then ones that belong to nobody); with `liveIndex`, the event at that place (0 = the first) is a LIVE-mode object, from the `liveOnRead`-th read of the list on (default: the first)
  duringAmountRead?: { scenario: Scenario; nth: number }     // at the Nth read of that payment the refund makes its next move: the state changes WHILE the amount is read
  amountLagMs?: { scenario: Scenario; ms: number }          // the charge is updated this long AFTER the refund moved: the amount still belongs to the previous state for a while
  stateMissingFor?: Scenario                                 // `refunds.retrieve` answers for this scenario come back without a `status`
  refundAnswersNothingFor?: Scenario                         // the answer to `refunds.create` of this scenario is not an object (the refund exists in Stripe, the script gets null)
  latencyMs?: number                                         // every call takes this long (on the virtual clock)
  slowReads?: { call: string; scenario: Scenario; ms: number }
  piStatus?: Partial<Record<Scenario, string>>               // the status of the payment of a scenario (default: succeeded)
  piStatusAfterRefund?: Partial<Record<Scenario, string>>    // the status the payment takes once it has a refund
  failCall?: FailSpec[]                                      // calls that fail with an error of the SDK
  liveObjectOn?: string                                      // a live-mode object in the answer of this call
  rejectEvent?: string                                       // Stripe refuses this event type on the endpoint
  endpointAnswer?: 'invalid_request_other_param' | 'api_error' | 'connection_error' | 'permission_error'
  echoOnly?: string[]                                        // the endpoint comes back with only these event types
  secretInAField?: string                                    // a secret-shaped string in a field the script copies as it is
  stopAt?: StopAt
}
type FakeRefund = { id: string; scenario: Scenario | null; piId: string; amount: number; createdAtMs: number; plan: Plan; forced: number; movedAt: number[]; metadata: any; key?: string }
type CallRecord = { name: string; at: number; scenario: Scenario | null }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).filter((name) => record[name] !== undefined).sort().map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

class FakeAr2 {
  calls: string[] = []
  callLog: CallRecord[] = []
  stoppedAt: number | null = null
  intents = new Map<string, any>()
  refundsById = new Map<string, FakeRefund>()
  endpoints = new Map<string, any>()
  paymentRequests: Array<{ key?: string; params: any }> = []
  refundRequests: Array<{ key?: string; params: any; outcome: string }> = []
  private seq = 0
  private idem = new Map<string, { fingerprint: string; refund: FakeRefund }>()
  private intentReads = new Map<string, number>()
  private eventReads = 0
  private failures: Array<{ spec: FailSpec; seen: number; done: number }>
  constructor(public switches: Switches = {}, public time: Clock = clock()) {
    this.failures = (switches.failCall ?? []).map((spec) => ({ spec, seen: 0, done: 0 }))
  }

  private scenarioOfIntent(id: string): Scenario | null { return this.intents.get(id)?.scenario ?? null }
  private scenarioOfRefund(id: string): Scenario | null { return this.refundsById.get(id)?.scenario ?? null }
  private async enter(name: string, scenario: Scenario | null) {
    this.calls.push(name)
    this.callLog.push({ name, at: this.time.now(), scenario })
    const slow = this.switches.slowReads
    if (slow && slow.call === name && slow.scenario === scenario) await this.time.sleep(slow.ms)
    else if (this.switches.latencyMs) await this.time.sleep(this.switches.latencyMs)
    for (const entry of this.failures) {
      if (entry.spec.call !== name || (entry.spec.scenario && entry.spec.scenario !== scenario)) continue
      entry.seen++
      if (entry.seen <= (entry.spec.skip ?? 0) || entry.done >= entry.spec.times) continue
      entry.done++
      throw FAIL_ERRORS[entry.spec.error]()
    }
  }
  private live(name: string, value: any) { return this.switches.liveObjectOn === name ? { ...value, livemode: true } : value }

  // ---- the refunds in time ----
  private moveIndex(refund: FakeRefund, at: number = this.time.now()): number {
    const elapsed = at - refund.createdAtMs
    const byTime = refund.plan.moves.filter((move) => elapsed >= move.afterMs).length
    return Math.min(refund.plan.moves.length, Math.max(byTime, refund.forced))
  }
  private statusOf(refund: FakeRefund, at: number = this.time.now()): RefundState {
    const index = this.moveIndex(refund, at)
    return index === 0 ? refund.plan.initial : refund.plan.moves[index - 1].to
  }
  private moveTime(refund: FakeRefund, index: number): number { return refund.movedAt[index] ?? refund.createdAtMs + refund.plan.moves[index].afterMs }
  private counts(refund: FakeRefund, status: RefundState): boolean {
    if (status === 'succeeded') return true
    if (status === 'pending' || status === 'requires_action') return this.switches.pendingCounted !== false
    if (status === 'failed') return this.switches.failureDropsTheAmount === false
    return false
  }
  private amountRefunded(piId: string): number {
    let total = 0
    const lag = this.switches.amountLagMs
    for (const refund of this.refundsById.values()) {
      if (refund.piId !== piId) continue
      // with a lag, the charge shows the amount of the state the refund was in `ms` ago
      const at = lag && lag.scenario === refund.scenario ? this.time.now() - lag.ms : this.time.now()
      if (this.counts(refund, this.statusOf(refund, at))) total += refund.amount
    }
    return total
  }
  private view(refund: FakeRefund) {
    const status = this.statusOf(refund)
    const out: any = { id: refund.id, object: 'refund', status, amount: refund.amount, currency: 'eur', payment_intent: refund.piId, livemode: false, metadata: refund.metadata, created: Math.floor(refund.createdAtMs / 1000), receipt_number: 'RCPT-SECRET' }
    if (status === 'pending' && this.switches.pendingReason !== 'absent') out.pending_reason = this.switches.pendingReason ?? 'processing'
    const own = this.switches.refundBalanceTransaction ?? 'present'
    if (status === 'pending' || own === 'null') out.balance_transaction = null
    else if (own === 'present') out.balance_transaction = `txn_fake_for_refund_${refund.id}`
    if (status === 'failed' || status === 'canceled') {
      const reason = this.switches.failureReason
      if (reason !== 'absent') out.failure_reason = reason === undefined ? 'unknown' : reason
      const transaction = this.switches.failureBalanceTransaction ?? 'present'
      if (transaction === 'present') out.failure_balance_transaction = `txn_fake_for_${refund.id}`
      else if (transaction === 'null') out.failure_balance_transaction = null
    }
    return out
  }

  paymentIntents = {
    create: async (params: any, opts: any) => {
      const scenario: Scenario | null = params.payment_method === TOKEN_A ? 'A' : params.payment_method === TOKEN_B ? 'B' : null
      await this.enter('paymentIntents.create', scenario)
      this.paymentRequests.push({ key: opts?.idempotencyKey, params: structuredClone(params) })
      const id = `pi_fake_${++this.seq}`
      const intent = {
        id, object: 'payment_intent', status: (scenario && this.switches.piStatus?.[scenario]) ?? 'succeeded', amount: params.amount, currency: params.currency, livemode: false, metadata: params.metadata,
        payment_method: params.payment_method, client_secret: `${id}_secret_SHOULD_NEVER_BE_KEPT`, scenario,
        latest_charge: { id: `ch_fake_${this.seq}`, disputed: false, receipt_url: 'https://pay.stripe.test/receipts/SECRET', billing_details: { email: 'buyer@example.test' }, payment_method_details: { card: { last4: '4242', fingerprint: 'FPRINT' } } },
      }
      this.intents.set(id, intent)
      const { scenario: _scenario, ...visible } = intent
      return this.live('paymentIntents.create', { ...visible })
    },
    retrieve: async (id: string, params?: any) => {
      const scenario = this.scenarioOfIntent(id)
      await this.enter('paymentIntents.retrieve', scenario)
      const intent = this.intents.get(id)
      if (!intent) throw sdkError.notFound()
      const reads = (this.intentReads.get(id) ?? 0) + 1
      this.intentReads.set(id, reads)
      const during = this.switches.duringAmountRead
      if (during && during.scenario === scenario && during.nth === reads) for (const refund of this.refundsById.values()) if (refund.piId === id) { refund.forced = this.moveIndex(refund) + 1; refund.movedAt[refund.forced - 1] = this.time.now() }
      const amountRefunded = this.amountRefunded(id)
      const charge = { ...intent.latest_charge, amount_refunded: amountRefunded, refunded: amountRefunded >= intent.amount }
      const { scenario: _scenario, ...visible } = intent
      const expand: string[] = params?.expand ?? []
      const status = amountRefunded > 0 && scenario && this.switches.piStatusAfterRefund?.[scenario] ? this.switches.piStatusAfterRefund[scenario] : intent.status
      return this.live('paymentIntents.retrieve', { ...visible, status, latest_charge: expand.some((entry) => entry.startsWith('latest_charge')) ? charge : charge.id })
    },
    cancel: async (id: string) => {
      await this.enter('paymentIntents.cancel', this.scenarioOfIntent(id))
      const intent = this.intents.get(id)
      if (intent.status === 'succeeded') throw sdkError.invalidRequest()
      intent.status = 'canceled'
      return this.live('paymentIntents.cancel', { id, status: 'canceled' })
    },
  }

  refunds = {
    create: async (params: any, opts: any) => {
      const scenario = this.scenarioOfIntent(params.payment_intent)
      await this.enter('refunds.create', scenario)
      const intent = this.intents.get(params.payment_intent)
      if (!intent) throw sdkError.notFound()
      const key: string | undefined = opts?.idempotencyKey
      const fingerprint = canonical(params)
      const known = key ? this.idem.get(key) : undefined
      if (known) {
        if (known.fingerprint !== fingerprint) { this.refundRequests.push({ key, params: structuredClone(params), outcome: 'refused:idempotency_error' }); throw sdkError.idempotencyMismatch() }
        this.refundRequests.push({ key, params: structuredClone(params), outcome: 'replayed' })
        return this.live('refunds.create', this.view(known.refund))
      }
      const plan = scenario === 'A' ? (this.switches.planA ?? DEFAULT_A) : scenario === 'B' ? (this.switches.planB ?? DEFAULT_B) : { initial: 'succeeded' as RefundState, moves: [] }
      const refund: FakeRefund = { id: `re_fake_${++this.seq}`, scenario, piId: params.payment_intent, amount: params.amount, createdAtMs: this.time.now(), plan, forced: 0, movedAt: [], metadata: params.metadata, key }
      this.refundsById.set(refund.id, refund)
      if (key) this.idem.set(key, { fingerprint, refund })
      this.refundRequests.push({ key, params: structuredClone(params), outcome: 'created' })
      if (this.switches.refundAnswersNothingFor && this.switches.refundAnswersNothingFor === scenario) return null
      return this.live('refunds.create', this.view(refund))
    },
    retrieve: async (id: string) => {
      await this.enter('refunds.retrieve', this.scenarioOfRefund(id))
      const refund = this.refundsById.get(id)
      if (!refund) throw sdkError.notFound()
      if (this.switches.stateMissingFor && this.switches.stateMissingFor === refund.scenario) { const { status: _status, ...withoutState } = this.view(refund); return this.live('refunds.retrieve', withoutState) }
      return this.live('refunds.retrieve', this.view(refund))
    },
    list: async (params: any) => {
      await this.enter('refunds.list', this.scenarioOfIntent(params.payment_intent))
      return this.live('refunds.list', { data: [...this.refundsById.values()].filter((refund) => refund.piId === params.payment_intent).map((refund) => this.view(refund)) })
    },
  }

  balanceTransactions = {
    retrieve: async (id: string) => {
      const ofRefund = id.startsWith('txn_fake_for_refund_')
      await this.enter('balanceTransactions.retrieve', this.scenarioOfRefund(id.replace('txn_fake_for_refund_', '').replace('txn_fake_for_', '')))
      const error = this.switches.balanceTransactionError
      if (error) throw error === 'not_found' ? sdkError.notFound() : FAIL_ERRORS[error]()
      // the balance transaction of the refund itself takes the money out; the one of a failure puts it back
      return ofRefund
        ? { id, object: 'balance_transaction', type: 'refund', amount: -20, fee: 0, net: -20, reporting_category: 'refund', currency: 'eur', source: 're_SHOULD_NOT_BE_KEPT' }
        : { id, object: 'balance_transaction', type: 'refund_failure', amount: 20, fee: 0, net: 20, reporting_category: 'refund_failure', currency: 'eur', source: 're_SHOULD_NOT_BE_KEPT' }
    },
  }

  // The events Stripe DOCUMENTS for the two test payment methods: every refund announces `created`; the move to `succeeded` is a `refund.updated`, the move to `failed` a `refund.failed`; a charge is
  // `refunded` when its refund first counts. (What Stripe really generates is what T19 is about.)
  private eventsNow(): any[] {
    const out: any[] = []
    const push = (type: string, atMs: number, objectId: string) => out.push({ id: `evt_fake_${out.length + 1}`, object: 'event', type, created: Math.floor(atMs / 1000), livemode: false, data: { object: { id: objectId } } })
    for (const refund of this.refundsById.values()) {
      if (!refund.scenario) continue
      const chargeId = this.intents.get(refund.piId).latest_charge.id
      push('refund.created', refund.createdAtMs, refund.id)
      let counted = this.counts(refund, refund.plan.initial)
      if (counted) push('charge.refunded', refund.createdAtMs, chargeId)
      for (let index = 0; index < this.moveIndex(refund); index++) {
        const to = refund.plan.moves[index].to
        const at = this.moveTime(refund, index)
        if (to === 'failed') push('refund.failed', at, refund.id)
        else push('refund.updated', at, refund.id)
        if (this.switches.deprecatedUpdated) push('charge.refund.updated', at, refund.id)
        if (!counted && this.counts(refund, to)) { push('charge.refunded', at, chargeId); counted = true }
      }
    }
    return out
  }
  events = {
    list: async (params: any) => {
      await this.enter('events.list', null)
      if (this.switches.events === 'none') return this.live('events.list', { data: [] })
      this.eventReads++
      const lag = this.eventReads <= (this.switches.lagEventsForFirstReads ?? 0)
      let events = this.eventsNow().filter((event) => !(this.switches.omitEvents ?? []).includes(event.type))
      if (lag) events = events.filter((event) => ['refund.created', 'charge.refunded'].includes(event.type) && [...this.refundsById.values()].some((refund) => Math.floor(refund.createdAtMs / 1000) === event.created))
      if (Array.isArray(params?.types)) events = events.filter((event) => params.types.includes(event.type))
      if (params?.created?.gte !== undefined) events = events.filter((event) => event.created >= params.created.gte)
      events.sort((a, b) => b.created - a.created)
      const data: any[] = events.slice(0, params?.limit ?? 10)
      const padding = this.switches.eventsPadding
      if (padding) {
        // a page that is as long as Stripe's can be (limit 100): the events of the refunds first, then others that belong to no refund and no charge of this run
        for (let filler = 0; data.length < padding.total; filler++) data.push({ id: `evt_filler_${filler}`, object: 'event', type: 'refund.created', created: 1, livemode: false, data: { object: { id: `re_filler_${filler}`, livemode: false } } })
        if (padding.liveIndex !== undefined && this.eventReads >= (padding.liveOnRead ?? 1)) {
          data[padding.liveIndex] = { ...data[padding.liveIndex], livemode: true }
          if (this.stoppedAt === null) this.stoppedAt = this.calls.length // the FIRST live object that was handed over: nothing may be called after it
        }
      }
      return this.live('events.list', { data })
    },
  }

  webhookEndpoints = {
    create: async (params: any) => {
      await this.enter('webhookEndpoints.create', null)
      if (this.switches.rejectEvent && params.enabled_events.includes(this.switches.rejectEvent)) throw sdkError.eventTypeRefused(this.switches.rejectEvent)
      const answer = this.switches.endpointAnswer
      if (answer) throw ({ invalid_request_other_param: () => sdkError.invalidRequestAbout('url'), api_error: sdkError.api, connection_error: sdkError.connection, permission_error: sdkError.permission } as Record<string, () => Error>)[answer]()
      const id = `we_fake_${++this.seq}`
      const endpoint = { id, object: 'webhook_endpoint', enabled_events: this.switches.echoOnly ?? params.enabled_events, livemode: false, api_version: this.switches.secretInAField ?? null, secret: 'whsec_SHOULD_NEVER_BE_KEPT0123', lastResponse: { headers: { 'stripe-version': PINNED } } }
      this.endpoints.set(id, endpoint)
      return this.live('webhookEndpoints.create', endpoint)
    },
    del: async (id: string) => {
      await this.enter('webhookEndpoints.del', null)
      this.endpoints.delete(id)
      return this.live('webhookEndpoints.del', { id, deleted: true })
    },
  }

  // when the amount was read: the refund of the payment makes its next move (used by `duringAmountRead`)
  refundOf(scenario: Scenario): FakeRefund { return [...this.refundsById.values()].find((refund) => refund.scenario === scenario) as FakeRefund }
  secondsSinceCreation(scenario: Scenario, at: number): number { return (at - this.refundOf(scenario).createdAtMs) / 1000 }
}
function clientOf(fake: FakeAr2) {
  return { paymentIntents: fake.paymentIntents, refunds: fake.refunds, balanceTransactions: fake.balanceTransactions, events: fake.events, webhookEndpoints: fake.webhookEndpoints }
}
// The client the script gets. With `stopAt` it is the fake with ONE stop of the script itself injected at ONE call: 'livemode' = the answer comes back with a live-mode object, 'budget' = a
// maximum is reached BEFORE the call (the call is never made), 'clock' = the clock jumps past the allowed duration right after the call, so the Gate itself refuses the next one.
function stoppingClient(fake: FakeAr2, stop: StopAt, time: Clock) {
  let seen = 0
  const wrap = (target: any, trail: string[]): any => new Proxy(target, {
    get(object, property) {
      const value = object[property]
      if (typeof property !== 'string') return value
      const here = [...trail, property]
      if (typeof value === 'function') {
        return async (...args: any[]) => {
          const hit = here.join('.') === stop.call && ++seen === (stop.nth ?? 1)
          if (hit && stop.stop === 'budget') { fake.stoppedAt = fake.calls.length; throw new script.BudgetError('simulated: a maximum was reached before this call') }
          const result = await value.apply(object, args)
          if (hit && stop.stop === 'livemode') { fake.stoppedAt = fake.calls.length; return { ...result, livemode: true } }
          if (hit && stop.stop === 'clock') { fake.stoppedAt = fake.calls.length; await time.sleep(script.AR2_BUDGET.maxRunMs + 1) }
          return result
        }
      }
      return value && typeof value === 'object' ? wrap(value, here) : value
    },
  })
  return wrap(clientOf(fake), [])
}
const asClient = (fake: FakeAr2, time: Clock) => (fake.switches.stopAt ? stoppingClient(fake, fake.switches.stopAt, time) : clientOf(fake))

// ---- running the script against the fake ---------------------------------------------------------------------------------------------------------------------------------------
// (`yes` is false: the command line can no longer produce an AR-2 start with `--yes`, so no AR-2 options object here has it)
function ar2Options(over: Partial<Options> = {}): Options {
  return { dryRun: false, reportDir: path.join(os.tmpdir(), 'unused'), currency: 'eur', skipGuided: false, refundTestPm: null, runId: 'abcd1234', only: null, yes: false, protocol: 'ar2', ...over }
}
async function runAr2Fake(switches: Switches = {}, over: Partial<Options> = {}) {
  const time = clock()
  const fake = new FakeAr2(switches, time)
  const output: string[] = []
  const report = await script.run(asClient(fake, time), ar2Options(over), {
    now: time.now, sleep: time.sleep, say: (line) => output.push(line),
    prompt: async () => { throw new Error('AR-2 asks the owner nothing during the run') },
  })
  return { fake, report, output, time }
}
const factOf = (report: Report, id: string) => report.facts.find((fact) => fact.id === id)!
const idsOf = (report: Report) => report.facts.map((fact) => fact.id)
const partsOf = (fact: FactResult) => (((fact as { parts?: unknown }).parts ?? []) as Array<{ part: string; status: string; detail?: string }>)
const partStatus = (fact: FactResult, part: string) => partsOf(fact).find((entry) => entry.part === part)?.status
const partDetail = (fact: FactResult, part: string) => partsOf(fact).find((entry) => entry.part === part)?.detail ?? ''
const worstOf = (statuses: string[]) => (statuses.includes('contradicted') ? 'contradicted' : statuses.includes('not_confirmable') ? 'not_confirmable' : 'confirmed')
const statuses = (report: Report) => Object.fromEntries(report.facts.map((fact) => [fact.id, fact.status]))
const ALL_AR2 = ['T13B', 'T14A', 'T16A', 'T14B', 'T16B', 'T19']
const STATE_FACTS_A = ['T14A', 'T16A']
const STATE_FACTS_B = ['T14B', 'T16B']

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

// =====================================================================================================================================================================
// 1. The profile: dedicated, independent of SP1, and ENFORCED BY THE CODE before the operations
// =====================================================================================================================================================================
test('the AR-2 profile is exactly the one authorised: 2 payments of 1.00 (2.00 in all), 2 refunds of 0.20, 1 endpoint, 120 calls, 25 minutes, 10 minutes of observation per scenario, no retry, nothing else created', () => {
  const budget = script.AR2_BUDGET
  assert.equal(budget.paymentIntents, 2)
  assert.equal(budget.maxAmountCentsPerPayment, 100)
  assert.equal(budget.maxAmountCentsTotal, 200)
  assert.equal(budget.refunds, 2)
  assert.equal(budget.maxRefundAmountCents, 20)
  assert.equal(budget.webhookEndpoints, 1)
  assert.equal(budget.maxApiCalls, 120)
  assert.equal(budget.maxRunMs, 25 * 60_000)
  assert.equal(budget.observationWindowMs, 10 * 60_000)
  for (const none of ['checkoutSessions', 'disputeEvidenceSubmissions', 'customers', 'products', 'prices', 'invoices', 'paymentLinks'] as const) assert.equal(budget[none], 0, none)
  // the observation never reads after the window: its last scheduled read is before the end of it, in increasing order
  const schedule = budget.pollScheduleSeconds as readonly number[]
  assert.ok(schedule.length >= 10)
  assert.deepEqual([...schedule].sort((a, b) => a - b), [...schedule])
  assert.ok(schedule[schedule.length - 1] * 1000 < budget.observationWindowMs)
  assert.ok(2 * budget.observationWindowMs < budget.maxRunMs, 'two windows fit in the run')
})

test('SP1 is untouched: its declared maxima are the ones it was run with (run a9488563) and it has no allowed-call list, no refund cap', () => {
  const sp1 = script.BUDGET as Record<string, unknown>
  assert.deepEqual(
    { ...sp1 },
    { maxAmountCentsPerPayment: 100, maxAmountCentsTotal: 500, checkoutSessions: 2, paymentIntents: 5, refunds: 12, disputeEvidenceSubmissions: 2, webhookEndpoints: 1, customers: 0, products: 0, prices: 0, invoices: 0, paymentLinks: 0, maxApiCalls: 170, maxRunMs: 20 * 60_000, perCallTimeoutMs: 20_000, maxPollAttempts: 8, pollIntervalMs: 5_000, searchWindowMs: 90_000, searchIntervalMs: 10_000 },
  )
  assert.deepEqual(script.FACT_IDS, Array.from({ length: 18 }, (_, index) => `T${index + 1}`))
})

test('the gate of the AR-2 profile stops BEFORE a maximum is passed: the 3rd payment, a payment above 1.00, more than 2.00 in all, the 3rd refund, a refund above 0.20, a 2nd endpoint, the 121st call, minute 26', async () => {
  const budget = script.AR2_BUDGET
  const time = clock()
  const make = () => new script.Gate({}, time.now, budget)
  const noop = async () => ({})
  const payments = make()
  await payments.call('paymentIntents.create', noop, { creates: 'payment_intent', amountCents: 100 })
  await payments.call('paymentIntents.create', noop, { creates: 'payment_intent', amountCents: 100 })
  await assert.rejects(() => payments.call('paymentIntents.create', noop, { creates: 'payment_intent', amountCents: 100 }), script.BudgetError)
  await assert.rejects(() => make().call('paymentIntents.create', noop, { creates: 'payment_intent', amountCents: 101 }), /exceeds/)
  const money = make()
  await money.call('paymentIntents.create', noop, { amountCents: 100 })
  await money.call('paymentIntents.create', noop, { amountCents: 100 })
  await assert.rejects(() => money.call('paymentIntents.create', noop, { amountCents: 1 }), /total amount/)
  const refunds = make()
  await refunds.call('refunds.create', noop, { creates: 'refund', refundAmountCents: 20 })
  await refunds.call('refunds.create', noop, { creates: 'refund', refundAmountCents: 20 })
  await assert.rejects(() => refunds.call('refunds.create', noop, { creates: 'refund', refundAmountCents: 20 }), script.BudgetError)
  const big = make()
  await assert.rejects(() => big.call('refunds.create', noop, { creates: 'refund', refundAmountCents: 21 }), /exceeds 20/)
  assert.equal(big.created.refund, 0, 'a refund that is refused before the call is not counted as made')
  const endpoints = make()
  await endpoints.call('webhookEndpoints.create', noop, { creates: 'webhook_endpoint' })
  await assert.rejects(() => endpoints.call('webhookEndpoints.create', noop, { creates: 'webhook_endpoint' }), script.BudgetError)
  const busy = make()
  for (let i = 0; i < budget.maxApiCalls; i++) await busy.call('refunds.retrieve', noop)
  await assert.rejects(() => busy.call('refunds.retrieve', noop), /calls/)
  const slow = make()
  await time.sleep(budget.maxRunMs + 1)
  await assert.rejects(() => slow.call('refunds.retrieve', noop), /minutes/)
})

test('the gate of the AR-2 profile lets through ONLY the calls of the protocol: a Checkout Session, a customer, a product, a price, an invoice, a payment link, a dispute, a search, a refund cancellation, a capture are all refused before they are made', async () => {
  const gate = new script.Gate({}, clock().now, script.AR2_BUDGET)
  let made = 0
  const attempt = (name: string, meta = {}) => gate.call(name, async () => { made++; return {} }, meta)
  for (const forbidden of ['checkout.sessions.create', 'checkout.sessions.retrieve', 'checkout.sessions.expire', 'customers.create', 'products.create', 'prices.create', 'invoices.create', 'invoiceItems.create', 'paymentLinks.create', 'disputes.update', 'disputes.retrieve', 'paymentIntents.search', 'paymentIntents.capture', 'refunds.cancel', 'subscriptions.create', 'accounts.create', 'transfers.create', 'payouts.create']) {
    await assert.rejects(() => attempt(forbidden), (error: unknown) => error instanceof script.BudgetError && /not part of this protocol/.test((error as Error).message), forbidden)
  }
  await assert.rejects(() => attempt('anything', { creates: 'checkout_session' }), script.BudgetError)
  assert.equal(made, 0, 'a refused call was made')
  for (const allowed of ['paymentIntents.create', 'paymentIntents.retrieve', 'paymentIntents.cancel', 'refunds.create', 'refunds.retrieve', 'refunds.list', 'events.list', 'balanceTransactions.retrieve', 'webhookEndpoints.create', 'webhookEndpoints.del']) await attempt(allowed)
  assert.equal(made, 10)
  assert.deepEqual([...script.AR2_BUDGET.allowedCalls].sort(), ['balanceTransactions.retrieve', 'events.list', 'paymentIntents.cancel', 'paymentIntents.create', 'paymentIntents.retrieve', 'refunds.create', 'refunds.list', 'refunds.retrieve', 'webhookEndpoints.create', 'webhookEndpoints.del'])
  // the creation of a Checkout Session, a dispute evidence or more than the allowed objects is also refused by the counters of the profile (limit 0)
  const counters = new script.Gate({}, clock().now, { ...script.AR2_BUDGET, allowedCalls: undefined })
  await assert.rejects(() => counters.call('x', async () => ({}), { creates: 'checkout_session' }), script.BudgetError)
  await assert.rejects(() => counters.call('x', async () => ({}), { creates: 'dispute_evidence' }), script.BudgetError)
})

test('the gate of SP1 is what it was: no list of allowed calls, no cap on a refund - the profile decides, not the gate', async () => {
  const gate = new script.Gate({}, clock().now)
  await gate.call('checkout.sessions.create', async () => ({}), { creates: 'checkout_session' })
  await gate.call('refunds.create', async () => ({}), { creates: 'refund', refundAmountCents: 99_999 })
  await gate.call('anything.at.all', async () => ({}))
  assert.equal(gate.budget, script.BUDGET)
})

// =====================================================================================================================================================================
// 2. Selection: explicit, and SP1 stays the default
// =====================================================================================================================================================================
test('the arguments: --protocol ar2 selects AR-2; without it the protocol is SP1; anything else is refused; --only takes the facts of the protocol selected; SP1-only options are refused with AR-2', () => {
  const plain = script.parseArgs(['--dry-run']) as { options: Options }
  assert.equal(script.protocolOf(plain.options), 'sp1', 'a plain start is SP1')
  assert.notEqual(plain.options.protocol, 'ar2')
  const explicit = script.parseArgs(['--protocol', 'ar2', '--dry-run']) as { options: Options }
  assert.equal(explicit.options.protocol, 'ar2')
  assert.equal(script.protocolOf(explicit.options), 'ar2')
  assert.equal(script.protocolOf((script.parseArgs(['--protocol', 'sp1']) as { options: Options }).options), 'sp1')
  for (const argv of [['--protocol'], ['--protocol', ''], ['--protocol', 'AR2'], ['--protocol', 'ar-2'], ['--protocol', 'sp2'], ['--protocol', 'both']]) assert.ok('error' in script.parseArgs(argv), JSON.stringify(argv))
  // the facts of each protocol belong to it
  assert.deepEqual(((script.parseArgs(['--protocol', 'ar2', '--only', 't14a,T19']) as { options: Options }).options.only), ['T14A', 'T19'])
  assert.match((script.parseArgs(['--protocol', 'ar2', '--only', 'T1']) as { error: string }).error, /Unknown fact/)
  assert.match((script.parseArgs(['--only', 'T14A']) as { error: string }).error, /Unknown fact/, 'AR-2 facts can not be asked from SP1')
  assert.ok('options' in script.parseArgs(['--only', 'T14']), 'SP1 still has its T14')
  // options that mean something only to SP1
  assert.match((script.parseArgs(['--protocol', 'ar2', '--refund-test-pm', 'pm_card_visa']) as { error: string }).error, /refund-test-pm/)
  assert.match((script.parseArgs(['--protocol', 'ar2', '--skip-guided']) as { error: string }).error, /skip-guided/)
  assert.ok('options' in script.parseArgs(['--refund-test-pm', 'pm_card_visa', '--skip-guided']), 'SP1 keeps both options')
  assert.ok('options' in script.parseArgs(['--protocol', 'ar2', '--currency', 'usd', '--run-id', 'ar2-0001', '--report-dir', '/x']))
})

// ---- the typed confirmation of AR-2 can not be skipped: `--yes` is refused ----------------------------------------------------------------------------------------------------------------
test('--yes belongs to SP1: with --protocol ar2 it is REFUSED - in any position, with or without --dry-run - and SP1 keeps it exactly as it was', () => {
  for (const argv of [
    ['--protocol', 'ar2', '--yes'],
    ['--yes', '--protocol', 'ar2'],
    ['--protocol', 'ar2', '--report-dir', '/x', '--yes', '--run-id', 'ar2-0001'],
    ['--protocol', 'ar2', '--dry-run', '--yes'],
    ['--yes', '--dry-run', '--protocol', 'ar2'],
    ['--protocol', 'ar2', '--only', 'T14A', '--yes'],
  ]) {
    const parsed = script.parseArgs(argv) as { error?: string; options?: Options }
    assert.ok(parsed.error, `${JSON.stringify(argv)} was accepted: AR-2 could be started without the typed word`)
    assert.equal(parsed.options, undefined)
    assert.match(parsed.error as string, /--yes/, 'the message does not name the option that was refused')
    assert.match(parsed.error as string, /AR-2/, 'the message does not say that AR-2 always asks for its word')
  }
  // AR-2 with all its other options is as before
  assert.ok('options' in script.parseArgs(['--protocol', 'ar2', '--currency', 'usd', '--run-id', 'ar2-0002', '--report-dir', '/x', '--only', 'T19', '--dry-run']))
  // SP1: --yes alone, after an explicit sp1, in any order, with the options of SP1 - accepted, and it is still `yes`
  for (const argv of [['--yes'], ['--protocol', 'sp1', '--yes'], ['--yes', '--protocol', 'sp1'], ['--yes', '--skip-guided', '--refund-test-pm', 'pm_card_visa', '--report-dir', '/x'], ['--dry-run', '--yes']]) {
    const parsed = script.parseArgs(argv)
    assert.ok('options' in parsed, JSON.stringify(argv))
    assert.equal((parsed as { options: Options }).options.yes, true)
  }
  assert.equal((script.parseArgs([]) as { options: Options }).options.yes, false)
})

test('the typed confirmation: AR-2 ALWAYS needs it, whatever the options say; SP1 needs it unless --yes was given (as it always did)', () => {
  assert.equal(script.needsTypedConfirmation({ protocol: 'ar2', yes: false }), true)
  assert.equal(script.needsTypedConfirmation({ protocol: 'ar2', yes: true }), true, 'AR-2 skipped its confirmation because of `yes`')
  assert.equal(script.needsTypedConfirmation({ protocol: 'sp1', yes: false }), true)
  assert.equal(script.needsTypedConfirmation({ protocol: 'sp1', yes: true }), false)
  assert.equal(script.needsTypedConfirmation({ yes: false }), true, 'a plain start is SP1, and SP1 asks')
  assert.equal(script.needsTypedConfirmation({ yes: true }), false, 'a plain start is SP1, and SP1 skips the question with --yes')
})

// `main` with a SIMULATED prompt: no keyboard, no network, no file (the report goes to a list, the folder is never made), and a fake Stripe that records every call it gets
async function mainWithPrompt(argv: string[], answer: string | null, fake: FakeAr2 = new FakeAr2()) {
  const time = clock()
  fake.time = time // the fake and the script share one virtual clock
  const asked: string[] = []
  const out: string[] = []
  const written: Array<{ file: string; content: string }> = []
  const made: string[] = []
  let clients = 0
  const code = await script.main(argv, { STRIPE_SECRET_KEY: FAKE_KEY }, {
    say: (line) => out.push(line), createClient: () => { clients++; return asClient(fake, time) }, now: time.now, sleep: time.sleep, repoRoot: '/work/repo',
    prompt: async (question) => { asked.push(question); if (answer === null) throw new Error('no question was expected'); return answer },
    writeReport: (file, content) => { written.push({ file, content }) }, mkdir: (dir) => { made.push(dir) },
  })
  return { code, asked, out, written, made, clients, fake }
}

test('SIMULATED PROMPT: --yes with --protocol ar2 ends at once - exit 2, a message that names --yes and AR-2, no question, no client, no call to Stripe, no folder, no file', async () => {
  for (const argv of [['--protocol', 'ar2', '--report-dir', '/tmp/never', '--yes'], ['--yes', '--protocol', 'ar2', '--report-dir', '/tmp/never', '--run-id', 'noyes001']]) {
    const run = await mainWithPrompt(argv, null)
    const text = run.out.join('\n')
    assert.equal(run.code, 2, `${JSON.stringify(argv)}: ${text}`)
    assert.match(text, /--yes/)
    assert.match(text, /AR-2/)
    assert.deepEqual(run.asked, [], 'a question was asked, or a question was skipped silently')
    assert.equal(run.clients, 0, 'a client was built')
    assert.deepEqual(run.fake.calls, [], 'a call was made')
    assert.deepEqual(run.written, [], 'a report was written')
    assert.deepEqual(run.made, [], 'a folder was made')
    assert.ok(!text.includes(FAKE_KEY))
  }
  // and --dry-run does not make it acceptable
  const dry = await mainWithPrompt(['--protocol', 'ar2', '--dry-run', '--yes'], null)
  assert.equal(dry.code, 2)
  assert.deepEqual(dry.fake.calls, [])
})

test('SIMULATED PROMPT: the word AR-2 is asked exactly once, before any client or call, and with it - and only with it - the run goes on to its end', async () => {
  const run = await mainWithPrompt(['--protocol', 'ar2', '--report-dir', '/tmp/never', '--run-id', 'confirm01'], 'AR-2')
  assert.equal(run.code, 0, run.out.join('\n'))
  assert.equal(run.asked.length, 1, 'the word was asked more than once, or not at all')
  assert.match(run.asked[0], /Type AR-2 to go on/)
  assert.equal(run.clients, 1)
  assert.ok(run.fake.calls.length > 20, 'the run did not go on after the right word')
  assert.equal(run.written.length, 1)
  assert.match(run.written[0].file, /stripe-test-mode-verify-ar2-confirm01\.json$/)
  assert.equal((JSON.parse(run.written[0].content) as Report & { protocol?: string }).protocol, 'ar2')
})

test('SIMULATED PROMPT: nothing but the word AR-2 starts AR-2 - YES (the word of SP1), yes, an empty answer, only spaces, a near miss, a longer text: exit 2, "Nothing was done.", no client, no call, no file', async () => {
  const wrong = ['YES', 'yes', 'Yes', 'y', 'Y', '', '   ', '\t', 'ar-2', 'Ar-2', 'AR2', 'AR 2', 'AR_2', 'AR-', 'AR-22', 'AR-1', 'AR-2 please', 'please AR-2', 'AR-2;AR-2', 'no', 'NO', 'sp1', 'ar2']
  for (const answer of wrong) {
    const run = await mainWithPrompt(['--protocol', 'ar2', '--report-dir', '/tmp/never'], answer)
    assert.equal(run.code, 2, `"${answer}" started AR-2`)
    assert.equal(run.asked.length, 1, `"${answer}"`)
    assert.ok(run.out.includes('Nothing was done.'), `"${answer}": the owner is not told that nothing was done`)
    assert.equal(run.clients, 0, `"${answer}": a client was built`)
    assert.deepEqual(run.fake.calls, [], `"${answer}": a call was made`)
    assert.deepEqual(run.written, [], `"${answer}": a report was written`)
  }
  assert.ok(wrong.length >= 20)
})

test('SIMULATED PROMPT: SP1 is as it was - with --yes it asks nothing, without it it asks for YES (and AR-2 does not start it)', async () => {
  // with --yes: no question at all (a question would make the prompt throw)
  const skipped = await mainWithPrompt(['--report-dir', '/tmp/never', '--yes', '--run-id', 'sp1yes001', '--skip-guided'], null)
  assert.deepEqual(skipped.asked, [], 'SP1 --yes asked a question')
  assert.equal(skipped.clients, 1)
  assert.equal(skipped.written.length, 1)
  assert.match(skipped.written[0].file, /stripe-test-mode-verify-sp1yes001\.json$/)
  // without it: one question, whose word is YES
  for (const answer of ['no', '', 'AR-2', 'yes']) {
    const asked = await mainWithPrompt(['--report-dir', '/tmp/never', '--skip-guided'], answer)
    assert.equal(asked.code, 2, `"${answer}"`)
    assert.equal(asked.asked.length, 1)
    assert.match(asked.asked[0], /Type YES to go on/)
    assert.equal(asked.clients, 0)
  }
  // an explicit sp1 with --yes is the same SP1
  const explicit = await mainWithPrompt(['--protocol', 'sp1', '--report-dir', '/tmp/never', '--yes', '--run-id', 'sp1yes002', '--skip-guided'], null)
  assert.deepEqual(explicit.asked, [])
  assert.equal(explicit.written.length, 1)
})

test('--dry-run of AR-2: no key, no connection, no client, nothing written; it names the protocol, the two scenarios, the facts, the maxima and the differences from SP1', async () => {
  let clients = 0
  const written: string[] = []
  const output: string[] = []
  const { result: code, attempts } = await withNetworkBlocked(() => script.main(['--protocol', 'ar2', '--dry-run', '--run-id', 'abcd1234'], {}, { say: (line) => output.push(line), createClient: () => { clients++; return {} }, writeReport: (file) => { written.push(file) } }))
  assert.equal(code, 0)
  assert.deepEqual(attempts, [])
  assert.equal(clients, 0)
  assert.deepEqual(written, [])
  const text = output.join('\n')
  assert.match(text, /DRY RUN - nothing is sent to Stripe/)
  assert.match(text, /protocol: AR-2/)
  assert.match(text, /--protocol ar2/)
  assert.match(text, /SP1[^\n]*NOT run/i)
  for (const id of ALL_AR2) assert.ok(text.includes(`${id} `), `${id} is not listed`)
  for (const sp1Only of ['T18 ', 'T2 ', 'T7 ']) assert.ok(!text.includes(sp1Only), `an SP1 fact is listed: ${sp1Only}`)
  assert.ok(text.includes(TOKEN_A) && text.includes(TOKEN_B), 'the two payment methods')
  const budget = script.AR2_BUDGET
  assert.match(text, new RegExp(`PaymentIntents: ${budget.paymentIntents}`))
  assert.match(text, new RegExp(`refunds: ${budget.refunds} of ${(budget.maxRefundAmountCents / 100).toFixed(2)}`))
  assert.match(text, new RegExp(`${(budget.maxAmountCentsTotal / 100).toFixed(2)} EUR in total`))
  assert.match(text, new RegExp(`webhook endpoints: ${budget.webhookEndpoints}`))
  assert.match(text, new RegExp(`API calls: at most ${budget.maxApiCalls}`))
  assert.match(text, new RegExp(`duration: at most ${budget.maxRunMs / 60000} minutes`))
  assert.match(text, new RegExp(`${budget.observationWindowMs / 60000} minutes per scenario`))
  assert.match(text, /no automatic retry/)
  assert.match(text, /Checkout Sessions: 0/)
  assert.match(text, /Differences from the SP1 profile/)
  assert.match(text, /can not be deleted/)
  assert.match(text, /type AR-2/i)
  assert.match(text, /--yes is refused with --protocol ar2/, 'the plan does not say that --yes is refused')
  assert.match(text, /read twice in each state, at least 5 seconds apart[^\n]*one reading, or two closer than that, confirm nothing/, 'the plan does not say what a measure needs')
  assert.ok(!text.includes(FAKE_KEY))
})

test('--dry-run of the default start is SP1, says so, and points to AR-2 without listing any of its facts', async () => {
  const output: string[] = []
  const { result: code, attempts } = await withNetworkBlocked(() => script.main(['--dry-run', '--run-id', 'abcd1234'], {}, { say: (line) => output.push(line) }))
  assert.equal(code, 0)
  assert.deepEqual(attempts, [])
  const text = output.join('\n')
  assert.match(text, /protocol: SP1/)
  assert.match(text, /--protocol ar2/)
  for (const id of script.FACT_IDS) assert.ok(text.includes(`${id} `), `${id} is not listed`)
  for (const id of ['T13B', 'T14A', 'T14B', 'T16A', 'T16B', 'T19']) assert.ok(!text.includes(`${id} `), `${id} (AR-2) is listed by SP1`)
  assert.ok(!text.includes(TOKEN_A) && !text.includes(TOKEN_B))
  assert.match(text, new RegExp(`PaymentIntents: ${script.BUDGET.paymentIntents}`))
})

test('--dry-run of AR-2 with a LIVE key in the environment still stops; with a test key it goes on and the key is never printed', async () => {
  const output: string[] = []
  assert.equal(await script.main(['--protocol', 'ar2', '--dry-run'], { STRIPE_SECRET_KEY: 'sk_live_51ABCdefGHI' }, { say: (line) => output.push(line) }), 2)
  assert.match(output.join('\n'), /LIVE key/)
  const quiet: string[] = []
  assert.equal(await script.main(['--protocol', 'ar2', '--dry-run'], { STRIPE_SECRET_KEY: FAKE_KEY }, { say: (line) => quiet.push(line) }), 0)
  assert.ok(!quiet.join('\n').includes(FAKE_KEY))
})

test('a real run of AR-2 needs the same things as SP1 (a test key, a folder outside the repository) and its OWN word, AR-2: "YES" - the word of SP1 - starts nothing', async () => {
  let clients = 0
  const asked: string[] = []
  const deps = (answer: string) => ({ say: () => undefined, createClient: () => { clients++; return {} }, repoRoot: '/work/repo', prompt: async (question: string) => { asked.push(question); return answer } })
  assert.equal(await script.main(['--protocol', 'ar2', '--report-dir', '/tmp/x'], {}, deps('AR-2')), 2, 'no key')
  assert.equal(await script.main(['--protocol', 'ar2', '--report-dir', '/tmp/x'], { STRIPE_SECRET_KEY: 'pk_test_51ABCdefGHI' }, deps('AR-2')), 2, 'a publishable key')
  assert.equal(await script.main(['--protocol', 'ar2'], { STRIPE_SECRET_KEY: FAKE_KEY }, deps('AR-2')), 2, 'no report folder')
  assert.equal(await script.main(['--protocol', 'ar2', '--report-dir', '/work/repo/out'], { STRIPE_SECRET_KEY: FAKE_KEY }, deps('AR-2')), 2, 'a folder inside the repository')
  for (const wrong of ['YES', 'yes', 'ar-2', 'AR2', '', 'no']) assert.equal(await script.main(['--protocol', 'ar2', '--report-dir', '/tmp/x'], { STRIPE_SECRET_KEY: FAKE_KEY }, deps(wrong)), 2, `"${wrong}"`)
  assert.equal(clients, 0, 'a client was built although nothing was allowed to start')
  assert.ok(asked.length >= 6 && asked.every((question) => /AR-2/.test(question)), 'the question names the word to type')
  // and the word of AR-2 does not start SP1
  const sp1 = { say: () => undefined, createClient: () => { clients++; return {} }, repoRoot: '/work/repo', prompt: async () => 'AR-2' }
  assert.equal(await script.main(['--report-dir', '/tmp/x'], { STRIPE_SECRET_KEY: FAKE_KEY }, sp1), 2)
  assert.equal(clients, 0)
})

test('a plain start of the script runs SP1 and nothing of AR-2: no payment with the AR-2 test methods, no refund event read, the facts are T1-T18 and the report has no AR-2 protocol', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plain-'))
  const time = clock()
  const fake = new FakeAr2({}, time)
  // (the fake knows only the calls of AR-2: SP1 will fail on the others, which is fine - what is looked at is what SP1 does NOT do)
  const written: string[] = []
  await script.main(['--report-dir', dir, '--yes', '--run-id', 'plain001', '--skip-guided'], { STRIPE_SECRET_KEY: FAKE_KEY }, {
    say: () => undefined, createClient: () => asClient(fake, time), now: time.now, sleep: time.sleep, repoRoot: '/work/repo', writeReport: (_file, content) => { written.push(content) },
  })
  assert.equal(written.length, 1)
  const report = JSON.parse(written[0]) as Report & { protocol?: string }
  assert.deepEqual(report.facts.map((fact) => fact.id), script.FACT_IDS)
  assert.notEqual(report.protocol, 'ar2')
  assert.ok(fake.paymentRequests.every((request) => ![TOKEN_A, TOKEN_B].includes(request.params.payment_method)), 'an AR-2 payment was made by a plain start')
  assert.ok(!fake.calls.includes('balanceTransactions.retrieve'))
  assert.deepEqual(report.budget, JSON.parse(JSON.stringify(script.BUDGET)))
  fs.rmSync(dir, { recursive: true, force: true })
})

// =====================================================================================================================================================================
// 3. The rules of the verdicts, on their own (pure): what each fact needs, and what leaves it NOT confirmable
// =====================================================================================================================================================================
const obs = (over: Partial<AsyncRefundObservation> & { scenario: Scenario }): AsyncRefundObservation => ({
  paymentMethod: over.scenario === 'A' ? TOKEN_A : TOKEN_B, paymentIntentStatus: 'succeeded', createdStatus: null, refundAmountCents: 20, pendingReason: null, timeline: [], samples: [], failure: null,
  listing: { read: 'not_attempted', refundsListed: null, statusInTheList: null, error: null }, readErrors: [], endedBecause: 'window_ended', observedForMs: 570_000, setupError: null, ...over,
})
const read = (at: number, status: string) => ({ at: at * 1000, status })
const sample = (at: number, before: string, amount: number | null, after: string = before, intent: string | null = 'succeeded'): AsyncRefundSample => ({
  at: at * 1000, statusBefore: before, amountRefunded: amount, chargeRefunded: amount === null ? null : amount >= 100, paymentIntentStatus: intent, statusAfter: after, stable: before === after,
})
// the same, with the instant in MILLISECONDS: the rule of a measure turns on 4999 ms against 5000 ms
const sampleMs = (atMs: number, before: string, amount: number | null, after: string = before): AsyncRefundSample => ({ ...sample(0, before, amount, after), at: atMs })
const checkParts = (fact: FactResult) => {
  assert.equal(fact.status, worstOf(partsOf(fact).map((entry) => entry.status)), `${fact.id}: the status is the worst of the parts`)
  for (const entry of partsOf(fact)) assert.ok(['confirmed', 'contradicted', 'not_confirmable'].includes(entry.status) && (entry.detail ?? '').length > 10, `${fact.id}/${entry.part}`)
  assert.ok(script.AR2_FACT_IDS.includes(fact.id))
}
// (every state's amount is read TWICE, 5 seconds apart, as the observation does it: one reading per state no longer counts as a measure - see the table of the measures below)
const PENDING_THEN_SUCCEEDED = { createdStatus: 'pending', timeline: [read(0, 'pending'), read(0, 'pending'), read(5, 'pending'), read(45, 'succeeded'), read(45, 'succeeded')], samples: [sample(0, 'pending', 20), sample(5, 'pending', 20), sample(45, 'succeeded', 20), sample(50, 'succeeded', 20)], endedBecause: 'final_state' as const }
const SUCCEEDED_THEN_FAILED = { createdStatus: 'succeeded', timeline: [read(0, 'succeeded'), read(0, 'succeeded'), read(90, 'failed'), read(90, 'failed')], samples: [sample(0, 'succeeded', 20), sample(5, 'succeeded', 20), sample(90, 'failed', 0), sample(95, 'failed', 0)], endedBecause: 'final_state' as const }

const T14A_CASES: Array<{ name: string; observation: Partial<AsyncRefundObservation>; status: string; parts: Record<string, string>; observed: string[]; notObserved: string[] }> = [
  { name: 'pending, then succeeded', observation: PENDING_THEN_SUCCEEDED, status: 'confirmed', parts: { only_known_states: 'confirmed', starts_pending: 'confirmed', becomes_succeeded: 'confirmed', payment_intent_stays_succeeded: 'confirmed' }, observed: ['pending', 'succeeded'], notObserved: ['requires_action', 'failed', 'canceled'] },
  { name: 'pending for the whole window: the transition was not seen', observation: { createdStatus: 'pending', timeline: [read(0, 'pending'), read(570, 'pending')], samples: [sample(0, 'pending', 20)] }, status: 'not_confirmable', parts: { only_known_states: 'confirmed', starts_pending: 'confirmed', becomes_succeeded: 'not_confirmable', payment_intent_stays_succeeded: 'confirmed' }, observed: ['pending'], notObserved: ['requires_action', 'succeeded', 'failed', 'canceled'] },
  { name: 'succeeded at once: it never started pending, so a pending -> succeeded transition was not seen', observation: { createdStatus: 'succeeded', timeline: [read(0, 'succeeded'), read(5, 'succeeded')], samples: [sample(0, 'succeeded', 20)] }, status: 'not_confirmable', parts: { only_known_states: 'confirmed', starts_pending: 'not_confirmable', becomes_succeeded: 'not_confirmable', payment_intent_stays_succeeded: 'confirmed' }, observed: ['succeeded'], notObserved: ['pending', 'requires_action', 'failed', 'canceled'] },
  { name: 'pending, then failed: another transition than the documented one', observation: { createdStatus: 'pending', timeline: [read(0, 'pending'), read(30, 'failed')], samples: [sample(0, 'pending', 20), sample(30, 'failed', 0)] }, status: 'not_confirmable', parts: { only_known_states: 'confirmed', starts_pending: 'confirmed', becomes_succeeded: 'not_confirmable', payment_intent_stays_succeeded: 'confirmed' }, observed: ['pending', 'failed'], notObserved: ['requires_action', 'succeeded', 'canceled'] },
  { name: 'a state outside the five that Stripe documents', observation: { createdStatus: 'pending', timeline: [read(0, 'pending'), read(20, 'a_state_nobody_knows')], samples: [sample(0, 'pending', 20)] }, status: 'contradicted', parts: { only_known_states: 'contradicted', starts_pending: 'confirmed', becomes_succeeded: 'not_confirmable', payment_intent_stays_succeeded: 'confirmed' }, observed: ['pending'], notObserved: ['requires_action', 'succeeded', 'failed', 'canceled'] },
  { name: 'the payment is no longer succeeded once it has the refund: the proof of payment does not decay only through the amount', observation: { ...PENDING_THEN_SUCCEEDED, samples: [sample(0, 'pending', 20, 'pending', 'succeeded'), sample(45, 'succeeded', 20, 'succeeded', 'canceled')] }, status: 'contradicted', parts: { only_known_states: 'confirmed', starts_pending: 'confirmed', becomes_succeeded: 'confirmed', payment_intent_stays_succeeded: 'contradicted' }, observed: ['pending', 'succeeded'], notObserved: ['requires_action', 'failed', 'canceled'] },
  { name: 'the payment was never read again after the refund: its status after the refund is not known', observation: { ...PENDING_THEN_SUCCEEDED, samples: [] }, status: 'not_confirmable', parts: { only_known_states: 'confirmed', starts_pending: 'confirmed', becomes_succeeded: 'confirmed', payment_intent_stays_succeeded: 'not_confirmable' }, observed: ['pending', 'succeeded'], notObserved: ['requires_action', 'failed', 'canceled'] },
  { name: 'no refund was ever made (the payment failed)', observation: { paymentIntentStatus: 'requires_action', endedBecause: 'not_started', setupError: { stage: 'payment', detail: 'The payment is requires_action, not succeeded.', error: null } }, status: 'not_confirmable', parts: { only_known_states: 'not_confirmable', starts_pending: 'not_confirmable', becomes_succeeded: 'not_confirmable', payment_intent_stays_succeeded: 'not_confirmable' }, observed: [], notObserved: ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'] },
]
for (const scenario of T14A_CASES) {
  test(`T14A, the rule on its own - ${scenario.name} -> ${scenario.status}`, () => {
    const fact = script.t14aResult(obs({ scenario: 'A', ...scenario.observation }))
    assert.equal(fact.id, 'T14A')
    assert.equal(fact.status, scenario.status, fact.note)
    assert.deepEqual(Object.fromEntries(partsOf(fact).map((entry) => [entry.part, entry.status])), scenario.parts)
    checkParts(fact)
    const observed = fact.observed as any
    assert.deepEqual(observed.statesObserved, scenario.observed, 'the states that were seen')
    assert.deepEqual(observed.statesNotObserved, scenario.notObserved, 'the states that were NOT seen')
    assert.match(fact.note, /States NOT observed:/, 'the note always says which states were not seen')
    if (scenario.status === 'not_confirmable') assert.match(fact.note, /NOT confirmed:/)
  })
}

const T14B_CASES: Array<{ name: string; observation: Partial<AsyncRefundObservation>; status: string; parts: Record<string, string> }> = [
  { name: 'succeeded, then failed - with every optional field', observation: { ...SUCCEEDED_THEN_FAILED, failure: { reason: { present: true, value: 'unknown' }, balanceTransaction: { present: true, read: 'read', details: { type: 'refund_failure', amount: 20 }, error: null } } }, status: 'confirmed', parts: { only_known_states: 'confirmed', starts_succeeded: 'confirmed', becomes_failed: 'confirmed', payment_intent_stays_succeeded: 'confirmed' } },
  { name: 'succeeded, then failed - the failure balance transaction is NULL (it is nullable: it decides nothing)', observation: { ...SUCCEEDED_THEN_FAILED, failure: { reason: { present: true, value: 'unknown' }, balanceTransaction: { present: false, read: 'not_present', details: null, error: null } } }, status: 'confirmed', parts: { only_known_states: 'confirmed', starts_succeeded: 'confirmed', becomes_failed: 'confirmed', payment_intent_stays_succeeded: 'confirmed' } },
  { name: 'succeeded, then failed - no failure reason and no balance transaction at all', observation: { ...SUCCEEDED_THEN_FAILED, failure: { reason: { present: false, value: null }, balanceTransaction: { present: false, read: 'not_present', details: null, error: null } } }, status: 'confirmed', parts: { only_known_states: 'confirmed', starts_succeeded: 'confirmed', becomes_failed: 'confirmed', payment_intent_stays_succeeded: 'confirmed' } },
  { name: 'succeeded, then failed - the balance transaction exists but could not be read', observation: { ...SUCCEEDED_THEN_FAILED, failure: { reason: { present: true, value: 'unknown' }, balanceTransaction: { present: true, read: 'unreadable', details: null, error: { type: 'StripePermissionError', code: null, status: 403, param: null, message: 'no permission' } } } }, status: 'confirmed', parts: { only_known_states: 'confirmed', starts_succeeded: 'confirmed', becomes_failed: 'confirmed', payment_intent_stays_succeeded: 'confirmed' } },
  { name: 'succeeded for the whole window: the failure was not seen', observation: { createdStatus: 'succeeded', timeline: [read(0, 'succeeded'), read(570, 'succeeded')], samples: [sample(0, 'succeeded', 20)] }, status: 'not_confirmable', parts: { only_known_states: 'confirmed', starts_succeeded: 'confirmed', becomes_failed: 'not_confirmable', payment_intent_stays_succeeded: 'confirmed' } },
  { name: 'pending at the start: not the documented start', observation: { createdStatus: 'pending', timeline: [read(0, 'pending'), read(30, 'failed')], samples: [sample(0, 'pending', 20), sample(30, 'failed', 0)] }, status: 'not_confirmable', parts: { only_known_states: 'confirmed', starts_succeeded: 'not_confirmable', becomes_failed: 'not_confirmable', payment_intent_stays_succeeded: 'confirmed' } },
  { name: 'succeeded, then canceled (the other way to end): not the documented transition', observation: { createdStatus: 'succeeded', timeline: [read(0, 'succeeded'), read(30, 'canceled')], samples: [sample(0, 'succeeded', 20), sample(30, 'canceled', 0)] }, status: 'not_confirmable', parts: { only_known_states: 'confirmed', starts_succeeded: 'confirmed', becomes_failed: 'not_confirmable', payment_intent_stays_succeeded: 'confirmed' } },
  { name: 'a state outside the five', observation: { createdStatus: 'succeeded', timeline: [read(0, 'succeeded'), read(30, 'a_state_nobody_knows')], samples: [sample(0, 'succeeded', 20)] }, status: 'contradicted', parts: { only_known_states: 'contradicted', starts_succeeded: 'confirmed', becomes_failed: 'not_confirmable', payment_intent_stays_succeeded: 'confirmed' } },
]
for (const scenario of T14B_CASES) {
  test(`T14B, the rule on its own - ${scenario.name} -> ${scenario.status}`, () => {
    const fact = script.t14bResult(obs({ scenario: 'B', ...scenario.observation }))
    assert.equal(fact.id, 'T14B')
    assert.equal(fact.status, scenario.status, fact.note)
    assert.deepEqual(Object.fromEntries(partsOf(fact).map((entry) => [entry.part, entry.status])), scenario.parts)
    checkParts(fact)
    assert.match(fact.note, /States NOT observed:/)
    // the optional fields are recorded apart, and the failure part never depends on them
    const failure = (fact.observed as any).failure
    if (scenario.observation.failure) assert.deepEqual(failure, scenario.observation.failure)
    assert.ok(!partsOf(fact).some((entry) => /balance|reason/.test(entry.part)), 'an optional field is not a part of the verdict')
  })
}

const T16A_CASES: Array<{ name: string; observation: Partial<AsyncRefundObservation>; status: string; parts: Record<string, string>; check: (observed: any) => void }> = [
  { name: 'the pending refund is counted, and the success changes nothing', observation: PENDING_THEN_SUCCEEDED, status: 'confirmed', parts: { amount_while_pending: 'confirmed', amount_after_success: 'confirmed' }, check: (o) => { assert.equal(o.amountWhilePending, 20); assert.equal(o.pendingRefundCountedInAmountRefunded, true); assert.equal(o.amountAfterSuccess, 20); assert.equal(o.successChangedTheAmount, 'unchanged') } },
  { name: 'the pending refund is NOT counted, and the success raises the amount', observation: { ...PENDING_THEN_SUCCEEDED, samples: [sample(0, 'pending', 0), sample(5, 'pending', 0), sample(45, 'succeeded', 20), sample(50, 'succeeded', 20)] }, status: 'confirmed', parts: { amount_while_pending: 'confirmed', amount_after_success: 'confirmed' }, check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, false); assert.equal(o.successChangedTheAmount, 'rose') } },
  { name: 'an amount that is neither 0 nor the refund', observation: { ...PENDING_THEN_SUCCEEDED, samples: [sample(0, 'pending', 7), sample(5, 'pending', 7), sample(45, 'succeeded', 20), sample(50, 'succeeded', 20)] }, status: 'confirmed', parts: { amount_while_pending: 'confirmed', amount_after_success: 'confirmed' }, check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, 'other:7') } },
  { name: 'only the pending half was caught (two readings of it)', observation: { createdStatus: 'pending', timeline: [read(0, 'pending')], samples: [sample(0, 'pending', 20), sample(5, 'pending', 20)] }, status: 'not_confirmable', parts: { amount_while_pending: 'confirmed', amount_after_success: 'not_confirmable' }, check: (o) => { assert.equal(o.amountWhilePending, 20); assert.equal(o.amountAfterSuccess, null); assert.equal(o.successChangedTheAmount, null) } },
  { name: 'only the succeeded half was caught (the refund succeeded at once; two readings of it)', observation: { createdStatus: 'succeeded', timeline: [read(0, 'succeeded')], samples: [sample(0, 'succeeded', 20), sample(5, 'succeeded', 20)] }, status: 'not_confirmable', parts: { amount_while_pending: 'not_confirmable', amount_after_success: 'confirmed' }, check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, null); assert.equal(o.amountAfterSuccess, 20) } },
  {
    name: 'the state changed while the amount was read: that sample must not be used (the amount belongs to the new state)', observation: { createdStatus: 'pending', timeline: [read(0, 'pending'), read(0, 'succeeded'), read(0, 'succeeded')], samples: [sample(0, 'pending', 20, 'succeeded'), sample(0, 'succeeded', 20), sample(5, 'succeeded', 20)] },
    status: 'not_confirmable', parts: { amount_while_pending: 'not_confirmable', amount_after_success: 'confirmed' }, check: (o) => { assert.equal(o.pendingRefundCountedInAmountRefunded, null, 'a claim about pending refunds from a sample taken while the state changed'); assert.equal(o.unusedSamples, 1); assert.equal(o.samples.length, 3) },
  },
  { name: 'a stable sample whose amount could not be read says nothing', observation: { ...PENDING_THEN_SUCCEEDED, samples: [sample(0, 'pending', null), sample(45, 'succeeded', 20), sample(50, 'succeeded', 20)] }, status: 'not_confirmable', parts: { amount_while_pending: 'not_confirmable', amount_after_success: 'confirmed' }, check: (o) => { assert.equal(o.amountWhilePending, null) } },
  { name: 'each state read twice, five seconds apart, the same amount both times', observation: { ...PENDING_THEN_SUCCEEDED, samples: [sample(0, 'pending', 20), sample(5, 'pending', 20), sample(45, 'succeeded', 20), sample(50, 'succeeded', 20)] }, status: 'confirmed', parts: { amount_while_pending: 'confirmed', amount_after_success: 'confirmed' }, check: (o) => { assert.deepEqual(o.amountSamplesWhilePending, [20, 20]); assert.deepEqual(o.amountSamplesAfterSuccess, [20, 20]); assert.equal(o.pendingRefundCountedInAmountRefunded, true) } },
  { name: 'the two readings of the pending state DISAGREE (0, then 20): nothing is claimed about a pending refund - it is not settled', observation: { ...PENDING_THEN_SUCCEEDED, samples: [sample(0, 'pending', 0), sample(5, 'pending', 20), sample(45, 'succeeded', 20), sample(50, 'succeeded', 20)] }, status: 'not_confirmable', parts: { amount_while_pending: 'not_confirmable', amount_after_success: 'confirmed' }, check: (o) => { assert.deepEqual(o.amountSamplesWhilePending, [0, 20]); assert.equal(o.amountWhilePending, null); assert.equal(o.pendingRefundCountedInAmountRefunded, null); assert.equal(o.successChangedTheAmount, null) } },
  { name: 'the two readings after the success DISAGREE (0, then 20): the success is not measured', observation: { ...PENDING_THEN_SUCCEEDED, samples: [sample(0, 'pending', 0), sample(5, 'pending', 0), sample(45, 'succeeded', 0), sample(50, 'succeeded', 20)] }, status: 'not_confirmable', parts: { amount_while_pending: 'confirmed', amount_after_success: 'not_confirmable' }, check: (o) => { assert.deepEqual(o.amountSamplesAfterSuccess, [0, 20]); assert.equal(o.amountAfterSuccess, null); assert.equal(o.successChangedTheAmount, null, 'a "the success changed nothing" from a stale reading') } },
]
for (const scenario of T16A_CASES) {
  test(`T16A, the rule on its own - ${scenario.name} -> ${scenario.status}`, () => {
    const fact = script.t16aResult(obs({ scenario: 'A', ...scenario.observation }))
    assert.equal(fact.id, 'T16A')
    assert.equal(fact.status, scenario.status, fact.note)
    assert.deepEqual(Object.fromEntries(partsOf(fact).map((entry) => [entry.part, entry.status])), scenario.parts)
    checkParts(fact)
    assert.notEqual(fact.status, 'contradicted', 'T16A is a measurement: it is never contradicted')
    scenario.check(fact.observed)
  })
}

const T16B_CASES: Array<{ name: string; observation: Partial<AsyncRefundObservation>; status: string; parts: Record<string, string>; check: (observed: any) => void }> = [
  { name: 'the amount goes back down when the refund fails', observation: SUCCEEDED_THEN_FAILED, status: 'confirmed', parts: { amount_after_success: 'confirmed', amount_after_failure: 'confirmed' }, check: (o) => { assert.equal(o.amountAfterSuccess, 20); assert.equal(o.amountAfterFailure, 0); assert.equal(o.effectOfTheFailureOnTheAmount, 'went_back_down'); assert.equal(o.differenceCents, -20) } },
  { name: 'the amount does NOT go back down when the refund fails', observation: { ...SUCCEEDED_THEN_FAILED, samples: [sample(0, 'succeeded', 20), sample(5, 'succeeded', 20), sample(90, 'failed', 20), sample(95, 'failed', 20)] }, status: 'confirmed', parts: { amount_after_success: 'confirmed', amount_after_failure: 'confirmed' }, check: (o) => { assert.equal(o.effectOfTheFailureOnTheAmount, 'unchanged'); assert.equal(o.differenceCents, 0) } },
  { name: 'the amount is higher after the failure than after the success (unexpected, and reported as it is)', observation: { ...SUCCEEDED_THEN_FAILED, samples: [sample(0, 'succeeded', 20), sample(5, 'succeeded', 20), sample(90, 'failed', 40), sample(95, 'failed', 40)] }, status: 'confirmed', parts: { amount_after_success: 'confirmed', amount_after_failure: 'confirmed' }, check: (o) => { assert.equal(o.effectOfTheFailureOnTheAmount, 'rose'); assert.equal(o.differenceCents, 20) } },
  { name: 'only the amount after the success was caught (two readings of it): nothing is said about the failure', observation: { createdStatus: 'succeeded', timeline: [read(0, 'succeeded')], samples: [sample(0, 'succeeded', 20), sample(5, 'succeeded', 20)] }, status: 'not_confirmable', parts: { amount_after_success: 'confirmed', amount_after_failure: 'not_confirmable' }, check: (o) => { assert.equal(o.amountAfterFailure, null); assert.equal(o.effectOfTheFailureOnTheAmount, null); assert.equal(o.differenceCents, null) } },
  { name: 'only the amount after the failure was caught (two readings of it): it can not be compared with the success', observation: { createdStatus: 'succeeded', timeline: [read(0, 'succeeded'), read(0, 'failed')], samples: [sample(0, 'succeeded', 0, 'failed'), sample(0, 'failed', 0), sample(5, 'failed', 0)] }, status: 'not_confirmable', parts: { amount_after_success: 'not_confirmable', amount_after_failure: 'confirmed' }, check: (o) => { assert.equal(o.amountAfterSuccess, null); assert.equal(o.amountAfterFailure, 0); assert.equal(o.effectOfTheFailureOnTheAmount, null, 'no comparison without both amounts'); assert.equal(o.unusedSamples, 1) } },
  { name: 'canceled is not failed: the amount after a cancellation is not the amount after a failure', observation: { createdStatus: 'succeeded', timeline: [read(0, 'succeeded'), read(30, 'canceled')], samples: [sample(0, 'succeeded', 20), sample(5, 'succeeded', 20), sample(30, 'canceled', 0), sample(35, 'canceled', 0)] }, status: 'not_confirmable', parts: { amount_after_success: 'confirmed', amount_after_failure: 'not_confirmable' }, check: (o) => { assert.equal(o.amountAfterFailure, null) } },
  { name: 'each state read twice, the same amount both times', observation: { ...SUCCEEDED_THEN_FAILED, samples: [sample(0, 'succeeded', 20), sample(5, 'succeeded', 20), sample(90, 'failed', 0), sample(95, 'failed', 0)] }, status: 'confirmed', parts: { amount_after_success: 'confirmed', amount_after_failure: 'confirmed' }, check: (o) => { assert.deepEqual(o.amountSamplesAfterSuccess, [20, 20]); assert.deepEqual(o.amountSamplesAfterFailure, [0, 0]); assert.equal(o.effectOfTheFailureOnTheAmount, 'went_back_down') } },
  { name: 'the two readings of the FAILED state DISAGREE (20, then 0: the charge was updated a moment after the refund): no comparison is made - never a false "unchanged"', observation: { ...SUCCEEDED_THEN_FAILED, samples: [sample(0, 'succeeded', 20), sample(5, 'succeeded', 20), sample(90, 'failed', 20), sample(95, 'failed', 0)] }, status: 'not_confirmable', parts: { amount_after_success: 'confirmed', amount_after_failure: 'not_confirmable' }, check: (o) => { assert.deepEqual(o.amountSamplesAfterFailure, [20, 0]); assert.equal(o.amountAfterFailure, null); assert.equal(o.effectOfTheFailureOnTheAmount, null); assert.equal(o.differenceCents, null) } },
  { name: 'the two readings of the SUCCEEDED state disagree: the starting amount is not settled either', observation: { ...SUCCEEDED_THEN_FAILED, samples: [sample(0, 'succeeded', 0), sample(5, 'succeeded', 20), sample(90, 'failed', 0), sample(95, 'failed', 0)] }, status: 'not_confirmable', parts: { amount_after_success: 'not_confirmable', amount_after_failure: 'confirmed' }, check: (o) => { assert.equal(o.amountAfterSuccess, null); assert.equal(o.effectOfTheFailureOnTheAmount, null) } },
]
for (const scenario of T16B_CASES) {
  test(`T16B, the rule on its own - ${scenario.name} -> ${scenario.status}`, () => {
    const fact = script.t16bResult(obs({ scenario: 'B', ...scenario.observation }))
    assert.equal(fact.id, 'T16B')
    assert.equal(fact.status, scenario.status, fact.note)
    assert.deepEqual(Object.fromEntries(partsOf(fact).map((entry) => [entry.part, entry.status])), scenario.parts)
    checkParts(fact)
    assert.notEqual(fact.status, 'contradicted', 'T16B is a measurement: it is never contradicted')
    scenario.check(fact.observed)
  })
}

// ---- a MEASURE needs two stable readings that agree and were taken at least five seconds apart ------------------------------------------------------------------------------------------
// One reading is not two. Two readings in the SAME instant (or less than `confirmAfterMs` apart) can both come before a charge that is updated a moment after the refund, so they would agree on a
// stale amount. Readings that disagree say that the measure is not settled. In every one of those cases the readings that WERE taken stay in the report, with the seconds they were taken at - the
// measure is just not declared confirmed, and nothing is claimed from it. The same table is played on each state whose amount is read: T16A pending and succeeded, T16B succeeded and failed.
type MeasureOutcome = 'no_sample' | 'one_sample' | 'disagree' | 'too_close' | 'settled'
type Reading = { atMs: number; amount: number | null; changedWhileRead?: boolean }
type MeasureCase = { name: string; readings: Reading[]; outcome: MeasureOutcome; amounts: number[]; atSeconds: number[]; detail: RegExp }
const MEASURE_CASES: MeasureCase[] = [
  { name: 'zero samples', readings: [], outcome: 'no_sample', amounts: [], atSeconds: [], detail: /No moment was caught/ },
  { name: 'one stable sample', readings: [{ atMs: 0, amount: 20 }], outcome: 'one_sample', amounts: [20], atSeconds: [0], detail: /only one reading/i },
  { name: 'one stable sample, late in the window', readings: [{ atMs: 300_000, amount: 20 }], outcome: 'one_sample', amounts: [20], atSeconds: [300], detail: /only one reading/i },
  { name: 'two concordant samples at the same instant', readings: [{ atMs: 7_000, amount: 20 }, { atMs: 7_000, amount: 20 }], outcome: 'too_close', amounts: [20, 20], atSeconds: [7, 7], detail: /less than 5 seconds apart/ },
  { name: 'two concordant samples 1 second apart', readings: [{ atMs: 0, amount: 20 }, { atMs: 1_000, amount: 20 }], outcome: 'too_close', amounts: [20, 20], atSeconds: [0, 1], detail: /less than 5 seconds apart/ },
  { name: 'two concordant samples 4999 ms apart (one millisecond short)', readings: [{ atMs: 0, amount: 20 }, { atMs: 4_999, amount: 20 }], outcome: 'too_close', amounts: [20, 20], atSeconds: [0, 5], detail: /less than 5 seconds apart/ },
  { name: 'two concordant samples exactly 5000 ms apart', readings: [{ atMs: 0, amount: 20 }, { atMs: 5_000, amount: 20 }], outcome: 'settled', amounts: [20, 20], atSeconds: [0, 5], detail: /at least 5 seconds apart/ },
  { name: 'two concordant samples 40 seconds apart', readings: [{ atMs: 0, amount: 20 }, { atMs: 40_000, amount: 20 }], outcome: 'settled', amounts: [20, 20], atSeconds: [0, 40], detail: /at least 5 seconds apart/ },
  { name: 'three concordant samples, the first and the last 6 seconds apart (the middle one close to the first)', readings: [{ atMs: 0, amount: 20 }, { atMs: 1_000, amount: 20 }, { atMs: 6_000, amount: 20 }], outcome: 'settled', amounts: [20, 20, 20], atSeconds: [0, 1, 6], detail: /at least 5 seconds apart/ },
  { name: 'three concordant samples, a pair 5 seconds apart and then one right after (the gap is the span of all of them, not of the last two)', readings: [{ atMs: 0, amount: 20 }, { atMs: 5_000, amount: 20 }, { atMs: 6_000, amount: 20 }], outcome: 'settled', amounts: [20, 20, 20], atSeconds: [0, 5, 6], detail: /at least 5 seconds apart/ },
  { name: 'three concordant samples, all inside four seconds', readings: [{ atMs: 0, amount: 20 }, { atMs: 2_000, amount: 20 }, { atMs: 4_000, amount: 20 }], outcome: 'too_close', amounts: [20, 20, 20], atSeconds: [0, 2, 4], detail: /less than 5 seconds apart/ },
  { name: 'two discordant samples far apart (20, then 0)', readings: [{ atMs: 0, amount: 20 }, { atMs: 40_000, amount: 0 }], outcome: 'disagree', amounts: [20, 0], atSeconds: [0, 40], detail: /do not agree/ },
  { name: 'two discordant samples at the same instant', readings: [{ atMs: 3_000, amount: 20 }, { atMs: 3_000, amount: 0 }], outcome: 'disagree', amounts: [20, 0], atSeconds: [3, 3], detail: /do not agree/ },
  { name: 'three samples, the middle one disagrees', readings: [{ atMs: 0, amount: 20 }, { atMs: 3_000, amount: 0 }, { atMs: 8_000, amount: 20 }], outcome: 'disagree', amounts: [20, 0, 20], atSeconds: [0, 3, 8], detail: /do not agree/ },
  { name: 'a stable sample and, far later, one that was NOT stable (the state changed while the amount was read): the second does not count', readings: [{ atMs: 0, amount: 20 }, { atMs: 40_000, amount: 20, changedWhileRead: true }], outcome: 'one_sample', amounts: [20], atSeconds: [0], detail: /only one reading/i },
  { name: 'a stable sample and, far later, one whose amount could not be read: the second does not count', readings: [{ atMs: 0, amount: 20 }, { atMs: 40_000, amount: null }], outcome: 'one_sample', amounts: [20], atSeconds: [0], detail: /only one reading/i },
  { name: 'a stable pair 5 seconds apart and an unstable sample after it: the pair settles it, the unstable one stays out', readings: [{ atMs: 0, amount: 20 }, { atMs: 5_000, amount: 20 }, { atMs: 9_000, amount: 0, changedWhileRead: true }], outcome: 'settled', amounts: [20, 20], atSeconds: [0, 5], detail: /at least 5 seconds apart/ },
]
type MeasureContext = {
  label: string; scenario: Scenario; created: string; state: string; base: number; fact: (observation: AsyncRefundObservation) => FactResult; others: AsyncRefundSample[]
  part: string; otherPart: string; amountField: string; samplesField: string; otherAmountField: string; otherAmount: number; measureKey: string; otherMeasureKey: string
  claims: { settled: Record<string, unknown>; unsettled: Record<string, unknown> }
}
const MEASURE_CONTEXTS: MeasureContext[] = [
  { label: 'T16A / pending', scenario: 'A', created: 'pending', state: 'pending', base: 0, fact: (observation) => script.t16aResult(observation), others: [sampleMs(45_000, 'succeeded', 20), sampleMs(50_000, 'succeeded', 20)],
    part: 'amount_while_pending', otherPart: 'amount_after_success', amountField: 'amountWhilePending', samplesField: 'amountSamplesWhilePending', otherAmountField: 'amountAfterSuccess', otherAmount: 20, measureKey: 'pending', otherMeasureKey: 'succeeded',
    claims: { settled: { pendingRefundCountedInAmountRefunded: true, successChangedTheAmount: 'unchanged' }, unsettled: { pendingRefundCountedInAmountRefunded: null, successChangedTheAmount: null } } },
  { label: 'T16A / succeeded', scenario: 'A', created: 'pending', state: 'succeeded', base: 45_000, fact: (observation) => script.t16aResult(observation), others: [sampleMs(0, 'pending', 20), sampleMs(5_000, 'pending', 20)],
    part: 'amount_after_success', otherPart: 'amount_while_pending', amountField: 'amountAfterSuccess', samplesField: 'amountSamplesAfterSuccess', otherAmountField: 'amountWhilePending', otherAmount: 20, measureKey: 'succeeded', otherMeasureKey: 'pending',
    claims: { settled: { pendingRefundCountedInAmountRefunded: true, successChangedTheAmount: 'unchanged' }, unsettled: { pendingRefundCountedInAmountRefunded: true, successChangedTheAmount: null } } },
  { label: 'T16B / succeeded', scenario: 'B', created: 'succeeded', state: 'succeeded', base: 0, fact: (observation) => script.t16bResult(observation), others: [sampleMs(90_000, 'failed', 0), sampleMs(95_000, 'failed', 0)],
    part: 'amount_after_success', otherPart: 'amount_after_failure', amountField: 'amountAfterSuccess', samplesField: 'amountSamplesAfterSuccess', otherAmountField: 'amountAfterFailure', otherAmount: 0, measureKey: 'succeeded', otherMeasureKey: 'failed',
    claims: { settled: { effectOfTheFailureOnTheAmount: 'went_back_down', differenceCents: -20 }, unsettled: { effectOfTheFailureOnTheAmount: null, differenceCents: null } } },
  { label: 'T16B / failed', scenario: 'B', created: 'succeeded', state: 'failed', base: 90_000, fact: (observation) => script.t16bResult(observation), others: [sampleMs(0, 'succeeded', 20), sampleMs(5_000, 'succeeded', 20)],
    part: 'amount_after_failure', otherPart: 'amount_after_success', amountField: 'amountAfterFailure', samplesField: 'amountSamplesAfterFailure', otherAmountField: 'amountAfterSuccess', otherAmount: 20, measureKey: 'failed', otherMeasureKey: 'succeeded',
    claims: { settled: { effectOfTheFailureOnTheAmount: 'unchanged', differenceCents: 0 }, unsettled: { effectOfTheFailureOnTheAmount: null, differenceCents: null } } },
]
for (const context of MEASURE_CONTEXTS) {
  for (const scenario of MEASURE_CASES) {
    const settled = scenario.outcome === 'settled'
    test(`${context.label}, a measure on its own - ${scenario.name} -> ${settled ? 'confirmed' : 'NOT confirmed'}`, () => {
      const taken = scenario.readings.map((reading) => sampleMs(context.base + reading.atMs, context.state, reading.amount, reading.changedWhileRead ? 'requires_action' : context.state))
      const fact = context.fact(obs({ scenario: context.scenario, createdStatus: context.created, timeline: [read(0, context.created)], samples: [...context.others, ...taken] }))
      const observed = fact.observed as any
      // the verdict of the part, of the fact, and the explanation that goes with it
      assert.equal(partStatus(fact, context.part), settled ? 'confirmed' : 'not_confirmable', `${scenario.outcome}: ${partDetail(fact, context.part)}`)
      assert.match(partDetail(fact, context.part), scenario.detail)
      assert.equal(partStatus(fact, context.otherPart), 'confirmed', 'the other half of the fact is settled and stays so')
      assert.equal(fact.status, settled ? 'confirmed' : 'not_confirmable', fact.note)
      assert.notEqual(fact.status, 'contradicted', 'a measurement is never contradicted')
      checkParts(fact)
      // what the measure says: an amount ONLY when it is settled; the other half keeps its amount
      assert.equal(observed[context.amountField], settled ? 20 : null, `the amount of an unsettled measure was claimed: ${observed[context.amountField]}`)
      assert.equal(observed[context.otherAmountField], context.otherAmount)
      for (const [field, value] of Object.entries(settled ? context.claims.settled : context.claims.unsettled)) assert.equal(observed[field], value, field)
      assert.ok(settled ? /^Measured:/.test(fact.note) : !/^Measured:/.test(fact.note), `the note: ${fact.note}`)
      if (!settled) assert.match(fact.note, /two readings that agree and were taken at least 5 seconds apart/, 'the note does not say what a measure needs')
      // the raw observations stay in the report - every reading that was taken, in order, with its amount and its state - and so does the reason why the measure is (not) settled
      assert.deepEqual(observed[context.samplesField], scenario.amounts, 'the readings that were taken must stay in the report')
      const reported = (observed.samples as Array<{ statusBefore: string; statusAfter: string; amountRefunded: number | null; atSeconds: number; stable: boolean }>).filter((entry) => entry.statusBefore === context.state)
      assert.deepEqual(reported.map((entry) => entry.amountRefunded), scenario.readings.map((reading) => reading.amount), 'a reading is missing from the list of samples')
      assert.equal(observed.unusedSamples, scenario.readings.filter((reading) => reading.changedWhileRead || reading.amount === null).length)
      const measure = observed.measures?.[context.measureKey]
      assert.ok(measure, 'the report has no `measures` entry for this state')
      assert.equal(measure.outcome, scenario.outcome)
      assert.equal(measure.samples, scenario.amounts.length)
      assert.deepEqual(measure.amounts, scenario.amounts)
      assert.deepEqual(measure.atSeconds, scenario.atSeconds.map((seconds) => seconds + context.base / 1000), 'the seconds the readings were taken at')
      const usable = scenario.readings.filter((reading) => !reading.changedWhileRead && reading.amount !== null).map((reading) => reading.atMs)
      assert.equal(measure.spanMs, usable.length > 0 ? Math.max(...usable) - Math.min(...usable) : 0)
      // and the other state of the fact is described as settled
      assert.equal(observed.measures[context.otherMeasureKey].outcome, 'settled')
    })
  }
}

test('ONE reading per state - what the evaluator used to call enough: T16A and T16B confirm nothing, claim nothing, and keep the reading in the report', () => {
  const a = script.t16aResult(obs({ scenario: 'A', createdStatus: 'pending', timeline: [read(0, 'pending'), read(45, 'succeeded')], samples: [sample(0, 'pending', 20), sample(45, 'succeeded', 20)], endedBecause: 'final_state' }))
  const oa = a.observed as any
  assert.equal(a.status, 'not_confirmable', a.note)
  assert.deepEqual(Object.fromEntries(partsOf(a).map((entry) => [entry.part, entry.status])), { amount_while_pending: 'not_confirmable', amount_after_success: 'not_confirmable' })
  assert.deepEqual([oa.amountSamplesWhilePending, oa.amountSamplesAfterSuccess], [[20], [20]], 'the readings that were taken are in the report')
  assert.deepEqual([oa.amountWhilePending, oa.amountAfterSuccess, oa.pendingRefundCountedInAmountRefunded, oa.successChangedTheAmount], [null, null, null, null], 'a claim was made from one reading')
  assert.equal(oa.measures.pending.outcome, 'one_sample')
  assert.equal(oa.measures.succeeded.outcome, 'one_sample')
  assert.ok(!/^Measured:/.test(a.note), a.note)
  assert.match(a.note, /two readings that agree and were taken at least 5 seconds apart/)
  checkParts(a)
  const b = script.t16bResult(obs({ scenario: 'B', createdStatus: 'succeeded', timeline: [read(0, 'succeeded'), read(90, 'failed')], samples: [sample(0, 'succeeded', 20), sample(90, 'failed', 0)], endedBecause: 'final_state' }))
  const ob = b.observed as any
  assert.equal(b.status, 'not_confirmable', b.note)
  assert.deepEqual(Object.fromEntries(partsOf(b).map((entry) => [entry.part, entry.status])), { amount_after_success: 'not_confirmable', amount_after_failure: 'not_confirmable' })
  assert.deepEqual([ob.amountSamplesAfterSuccess, ob.amountSamplesAfterFailure], [[20], [0]])
  assert.deepEqual([ob.amountAfterSuccess, ob.amountAfterFailure, ob.effectOfTheFailureOnTheAmount, ob.differenceCents], [null, null, null, null], 'the amount "went back down" was claimed from two single readings')
  assert.equal(ob.measures.succeeded.outcome, 'one_sample')
  assert.equal(ob.measures.failed.outcome, 'one_sample')
  assert.ok(!/^Measured:/.test(b.note), b.note)
  assert.match(b.note, /two readings that agree and were taken at least 5 seconds apart/)
  checkParts(b)
})

test('a measure follows the budget, not a number written in the test: the gap that settles it is AR2_BUDGET.confirmAfterMs, to the millisecond', () => {
  const gap = script.AR2_BUDGET.confirmAfterMs
  assert.equal(gap, 5_000, 'the gap that the guide and the observation promise')
  const settledAt = (distanceMs: number) => ((script.t16aResult(obs({ scenario: 'A', createdStatus: 'pending', timeline: [read(0, 'pending')], samples: [sampleMs(0, 'pending', 20), sampleMs(distanceMs, 'pending', 20), sampleMs(45_000, 'succeeded', 20), sampleMs(50_000, 'succeeded', 20)] })).observed as any).measures.pending.outcome)
  assert.equal(settledAt(gap - 1), 'too_close')
  assert.equal(settledAt(gap), 'settled')
  assert.equal(settledAt(gap + 1), 'settled')
  assert.equal(settledAt(0), 'too_close')
})

test('the facts describe the rule of a measure: the methods of T16A and T16B say that TWO readings, at least 5 seconds apart, are needed', () => {
  for (const id of ['T16A', 'T16B']) {
    const fact = script.AR2_FACTS.find((entry) => entry.id === id)
    assert.ok(fact, id)
    assert.match((fact as { method: string }).method, /TWO/, id)
    assert.match((fact as { method: string }).method, /at least 5 seconds apart/, id)
  }
})

const events = (over: Partial<EventsRecord> = {}): EventsRecord => ({ ran: true, read: 'ok', passes: 1, error: null, documentedEvent: 'refund.updated', observedTypes: [{ type: 'refund.created', count: 1, firstAtSeconds: 0 }, { type: 'refund.updated', count: 1, firstAtSeconds: 40 }], notObservedTypes: ['refund.failed', 'charge.refund.updated', 'charge.refunded'], ...over })
const eventsB = (over: Partial<EventsRecord> = {}): EventsRecord => events({ documentedEvent: 'refund.failed', observedTypes: [{ type: 'refund.created', count: 1, firstAtSeconds: 0 }, { type: 'refund.failed', count: 1, firstAtSeconds: 90 }], notObservedTypes: ['refund.updated', 'charge.refund.updated', 'charge.refunded'], ...over })
const T19_CASES: Array<{ name: string; a: EventsRecord | null; b: EventsRecord | null; status: string; parts: Record<string, string>; detail: { A: RegExp; B: RegExp } }> = [
  { name: 'the documented event of each scenario was observed', a: events(), b: eventsB(), status: 'confirmed', parts: { A_documented_event_observed: 'confirmed', B_documented_event_observed: 'confirmed' }, detail: { A: /was observed 40 seconds/, B: /was observed 90 seconds/ } },
  { name: 'the list was read and the documented event of A is NOT in it: absence proves nothing', a: events({ observedTypes: [{ type: 'refund.created', count: 1, firstAtSeconds: 0 }], notObservedTypes: ['refund.updated', 'refund.failed', 'charge.refund.updated', 'charge.refunded'] }), b: eventsB(), status: 'not_confirmable', parts: { A_documented_event_observed: 'not_confirmable', B_documented_event_observed: 'confirmed' }, detail: { A: /NOT observed[\s\S]*does not show that Stripe does not generate/, B: /was observed/ } },
  { name: 'the events of B could not be read: a read error is not an absent event', a: events(), b: eventsB({ read: 'unreadable', observedTypes: [], notObservedTypes: [], error: { type: 'StripePermissionError', code: null, status: 403, param: null, message: 'no permission' } }), status: 'not_confirmable', parts: { A_documented_event_observed: 'confirmed', B_documented_event_observed: 'not_confirmable' }, detail: { A: /was observed/, B: /could not be read/ } },
  { name: 'no event at all in the list, in both scenarios', a: events({ observedTypes: [], notObservedTypes: ['refund.created', 'refund.updated', 'refund.failed', 'charge.refund.updated', 'charge.refunded'] }), b: eventsB({ observedTypes: [], notObservedTypes: ['refund.created', 'refund.updated', 'refund.failed', 'charge.refund.updated', 'charge.refunded'] }), status: 'not_confirmable', parts: { A_documented_event_observed: 'not_confirmable', B_documented_event_observed: 'not_confirmable' }, detail: { A: /NOT observed/, B: /NOT observed/ } },
  { name: 'scenario B did not run (it stopped, it was not selected, or it had no refund)', a: events(), b: null, status: 'not_confirmable', parts: { A_documented_event_observed: 'confirmed', B_documented_event_observed: 'not_confirmable' }, detail: { A: /was observed/, B: /did not (run|produce)/ } },
  { name: 'neither scenario ran', a: null, b: null, status: 'not_confirmable', parts: { A_documented_event_observed: 'not_confirmable', B_documented_event_observed: 'not_confirmable' }, detail: { A: /did not (run|produce)/, B: /did not (run|produce)/ } },
  { name: 'other types were observed too (the deprecated one, the charge): they are reported and decide nothing', a: events({ observedTypes: [...events().observedTypes, { type: 'charge.refund.updated', count: 1, firstAtSeconds: 40 }, { type: 'charge.refunded', count: 1, firstAtSeconds: 0 }], notObservedTypes: ['refund.failed'] }), b: eventsB(), status: 'confirmed', parts: { A_documented_event_observed: 'confirmed', B_documented_event_observed: 'confirmed' }, detail: { A: /was observed/, B: /was observed/ } },
]
for (const scenario of T19_CASES) {
  test(`T19, the rule on its own - ${scenario.name} -> ${scenario.status}`, () => {
    const fact = script.t19Result({ A: scenario.a, B: scenario.b })
    assert.equal(fact.id, 'T19')
    assert.equal(fact.status, scenario.status, fact.note)
    assert.deepEqual(Object.fromEntries(partsOf(fact).map((entry) => [entry.part, entry.status])), scenario.parts)
    checkParts(fact)
    assert.notEqual(fact.status, 'contradicted', 'T19 is a measurement: an event that is missing never contradicts anything')
    assert.match(partDetail(fact, 'A_documented_event_observed'), scenario.detail.A)
    assert.match(partDetail(fact, 'B_documented_event_observed'), scenario.detail.B)
    const observed = fact.observed as any
    assert.equal(observed.A?.read ?? 'not_attempted', scenario.a?.read ?? 'not_attempted')
    if (scenario.a) assert.deepEqual(observed.A.observedTypes, scenario.a.observedTypes)
    if (scenario.a) assert.deepEqual(observed.A.notObservedTypes, scenario.a.notObservedTypes)
  })
}

// =====================================================================================================================================================================
// 4. Whole runs against the fake: the documented behaviour, then every way it might be otherwise
// =====================================================================================================================================================================
test('SIMULATED: a Stripe that behaves as documented - pending then succeeded (A), succeeded then failed (B) - confirms the six facts, each by what it SHOWED, inside the declared maxima', async () => {
  const { report, fake, output } = await runAr2Fake()
  assert.deepEqual(idsOf(report), ALL_AR2, 'every fact has exactly one answer, in the order of the protocol')
  assert.deepEqual(statuses(report), { T13B: 'confirmed', T14A: 'confirmed', T16A: 'confirmed', T14B: 'confirmed', T16B: 'confirmed', T19: 'confirmed' })
  assert.equal((report as Report & { protocol?: string }).protocol, 'ar2')
  assert.equal(report.aborted, null)
  assert.equal(report.livemodeSeen, false)
  assert.deepEqual(report.budget, JSON.parse(JSON.stringify(script.AR2_BUDGET)))
  // the usage is inside the profile, and what the fake received is what the script counted
  assert.equal(fake.calls.length, report.usage.apiCalls)
  assert.ok(report.usage.apiCalls <= script.AR2_BUDGET.maxApiCalls && report.usage.apiCalls >= 20, `calls ${report.usage.apiCalls}`)
  assert.deepEqual(report.usage.created, { checkout_session: 0, payment_intent: 2, refund: 2, dispute_evidence: 0, webhook_endpoint: 1 })
  assert.equal(report.usage.amountCents, 200)
  assert.ok(report.usage.elapsedMs <= script.AR2_BUDGET.maxRunMs)
  // the two payments are the two test methods of the table, 1.00 each; the two refunds are 0.20; nothing else was called
  assert.deepEqual(fake.paymentRequests.map((request) => request.params.payment_method), [TOKEN_A, TOKEN_B])
  assert.ok(fake.paymentRequests.every((request) => request.params.amount === 100 && request.params.confirm === true))
  assert.deepEqual(fake.refundRequests.map((request) => request.params.amount), [20, 20])
  assert.deepEqual(fake.refundRequests.map((request) => request.outcome), ['created', 'created'])
  const allowed = new Set<string>(script.AR2_BUDGET.allowedCalls)
  for (const name of fake.calls) assert.ok(allowed.has(name), `an unexpected call: ${name}`)
  assert.equal(fake.endpoints.size, 0, 'the throw-away endpoint was deleted')
  // what each fact says
  const a = factOf(report, 'T14A').observed as any
  assert.deepEqual(a.statesInOrder, ['pending', 'succeeded'])
  assert.deepEqual(a.statesObserved, ['pending', 'succeeded'])
  assert.deepEqual(a.statesNotObserved, ['requires_action', 'failed', 'canceled'])
  assert.deepEqual(a.transition, { from: 'pending', to: 'succeeded', lastSeenBeforeSeconds: 30, firstSeenAfterSeconds: 45 })
  assert.equal(a.endedBecause, 'final_state')
  const b = factOf(report, 'T14B').observed as any
  assert.deepEqual(b.statesInOrder, ['succeeded', 'failed'])
  assert.deepEqual(b.transition, { from: 'succeeded', to: 'failed', lastSeenBeforeSeconds: 60, firstSeenAfterSeconds: 90 })
  const t16a = factOf(report, 'T16A').observed as any
  assert.equal(t16a.pendingRefundCountedInAmountRefunded, true)
  assert.equal(t16a.amountWhilePending, 20)
  assert.equal(t16a.amountAfterSuccess, 20)
  // every state's amount is read TWICE, at least five seconds apart, and the two readings are the same
  assert.deepEqual(t16a.amountSamplesWhilePending, [20, 20])
  assert.deepEqual(t16a.amountSamplesAfterSuccess, [20, 20])
  const t16b = factOf(report, 'T16B').observed as any
  assert.equal(t16b.amountAfterSuccess, 20)
  assert.equal(t16b.amountAfterFailure, 0)
  assert.equal(t16b.effectOfTheFailureOnTheAmount, 'went_back_down')
  assert.deepEqual(t16b.amountSamplesAfterSuccess, [20, 20])
  assert.deepEqual(t16b.amountSamplesAfterFailure, [0, 0])
  // and the report says that every measure is SETTLED: two readings or more, in agreement, the first and the last at least five seconds apart
  for (const [measures, states] of [[t16a.measures, ['pending', 'succeeded']], [t16b.measures, ['succeeded', 'failed']]] as const) {
    for (const state of states) {
      assert.equal(measures?.[state]?.outcome, 'settled', `${state}: ${JSON.stringify(measures?.[state])}`)
      assert.equal(measures[state].samples, 2)
      assert.ok(measures[state].spanMs >= script.AR2_BUDGET.confirmAfterMs, `${state}: the two readings are ${measures[state].spanMs} ms apart`)
    }
  }
  for (const sampled of [t16a.samples, t16b.samples] as AsyncRefundSample[][]) {
    const stable = sampled.filter((entry: any) => entry.stable)
    for (const state of [...new Set(stable.map((entry) => entry.statusBefore))]) {
      const times = stable.filter((entry) => entry.statusBefore === state).map((entry: any) => entry.atSeconds)
      assert.ok(times.length === 2 && times[1] - times[0] >= script.AR2_BUDGET.confirmAfterMs / 1000, `${state}: the second reading came at ${times.join(', ')} seconds`)
    }
  }
  for (const id of ['T14A', 'T14B', 'T16A', 'T16B', 'T19']) { checkParts(factOf(report, id)); assert.ok(partsOf(factOf(report, id)).length >= 2, id) }
  assert.equal(output.length, 0, 'AR-2 says nothing on the screen during the run')
  assertCleanReport(report)
})
function assertCleanReport(report: Report) {
  const json = JSON.stringify(report)
  script.assertCleanReport(json, FAKE_KEY)
  for (const secret of [FAKE_KEY, 'SHOULD_NEVER_BE_KEPT', 'SHOULD_NOT_BE_KEPT', 'receipts/SECRET', 'buyer@example.test', 'RCPT-SECRET', '4242', 'FPRINT', 'client_secret', 'receipt_url', 'whsec_', 'txn_fake_for_']) assert.ok(!json.includes(secret), `"${secret}" leaked`)
}

// ---- the two scenarios are independent -------------------------------------------------------------------------------------------------------------------------------------
test('SIMULATED: the scenarios are independent - own payment, own refund, own keys, own metadata; the refund of one is never attributed to the other', async () => {
  const { fake, report } = await runAr2Fake()
  assert.equal(fake.intents.size, 2)
  const [a, b] = fake.paymentRequests
  assert.notEqual(a.key, b.key)
  assert.ok(a.key && b.key)
  const refundA = fake.refundOf('A')
  const refundB = fake.refundOf('B')
  assert.notEqual(refundA.piId, refundB.piId)
  assert.notEqual(refundA.key, refundB.key)
  assert.equal(refundA.metadata.scenario, 'A')
  assert.equal(refundB.metadata.scenario, 'B')
  assert.match(refundA.metadata.makerworksOperationId, /^[0-9a-f-]{36}$/)
  assert.notEqual(refundA.metadata.makerworksOperationId, refundB.metadata.makerworksOperationId)
  for (const refund of [refundA, refundB]) assert.equal(refund.metadata.makerworksVerify, 'abcd1234')
  for (const intent of fake.intents.values()) assert.equal(intent.metadata.makerworksVerify, 'abcd1234')
  // every creation was sent exactly once
  const keys = [...fake.paymentRequests, ...fake.refundRequests].map((request) => request.key)
  assert.equal(new Set(keys).size, keys.length, 'a key was used twice: something was sent again')
  assert.equal(fake.calls.filter((name) => name === 'paymentIntents.create').length, 2)
  assert.equal(fake.calls.filter((name) => name === 'refunds.create').length, 2)
  // the events of each scenario are the events of ITS refund
  const t19 = factOf(report, 'T19').observed as any
  assert.ok(!t19.A.observedTypes.some((entry: any) => entry.type === 'refund.failed'), 'a failure of B was attributed to A')
  assert.ok(!t19.B.observedTypes.some((entry: any) => entry.type === 'refund.updated'), 'an update of A was attributed to B')
})

const PAYMENT_OF = (scenario: Scenario): FailSpec => ({ call: 'paymentIntents.create', scenario, error: 'permission', times: 99 })
const REFUND_OF = (scenario: Scenario): FailSpec => ({ call: 'refunds.create', scenario, error: 'api', times: 99 })
const ISOLATION_CASES: Array<{ name: string; switches: Switches; broken: Scenario; check?: (fake: FakeAr2, report: Report) => void }> = [
  { name: 'the payment of A is refused (a permission error)', switches: { failCall: [PAYMENT_OF('A')] }, broken: 'A', check: (fake) => { assert.equal(fake.callLog.filter((call) => call.name === 'paymentIntents.create' && call.scenario === 'A').length, 1, 'the creation of A was sent more than once'); assert.equal(fake.refundRequests.length, 1) } },
  { name: 'the payment of B is refused', switches: { failCall: [PAYMENT_OF('B')] }, broken: 'B' },
  { name: 'the refund of A fails with a 500', switches: { failCall: [REFUND_OF('A')] }, broken: 'A', check: (fake) => { assert.equal(fake.calls.filter((name) => name === 'refunds.create').length, 2, 'one try per scenario, never a second one') } },
  { name: 'the refund of B fails with a 500', switches: { failCall: [REFUND_OF('B')] }, broken: 'B' },
  { name: 'the payment of A did not succeed (requires_action): nothing to refund', switches: { piStatus: { A: 'requires_action' } }, broken: 'A', check: (fake) => { assert.equal(fake.refundRequests.length, 1); assert.ok(fake.calls.includes('paymentIntents.cancel'), 'the payment that did not succeed is canceled at the end'); assert.equal(fake.calls.filter((name) => name === 'paymentIntents.cancel').length, 1) } },
  { name: 'a state nobody knows in A', switches: { planA: { initial: 'pending', moves: [{ afterMs: 10_000, to: 'a_state_nobody_knows' }] } }, broken: 'A' },
  { name: 'three reads of A in a row fail', switches: { failCall: [{ call: 'refunds.retrieve', scenario: 'A', error: 'connection', times: 3 }] }, broken: 'A' },
]
for (const scenario of ISOLATION_CASES) {
  test(`SIMULATED: isolation - ${scenario.name}: that scenario's facts say so, the other scenario is not touched`, async () => {
    const { report, fake } = await runAr2Fake(scenario.switches)
    const broken = scenario.broken === 'A' ? STATE_FACTS_A : STATE_FACTS_B
    const other = scenario.broken === 'A' ? STATE_FACTS_B : STATE_FACTS_A
    const unconfirmed: string[] = broken.map((id) => factOf(report, id).status)
    assert.ok(unconfirmed.every((status) => status !== 'confirmed') && unconfirmed.some((status) => status !== 'confirmed'), `${broken.join(',')}: ${unconfirmed.join(',')}`)
    for (const id of other) assert.equal(factOf(report, id).status, 'confirmed', `${id} was dragged along`)
    assert.equal(factOf(report, 'T13B').status, 'confirmed')
    assert.equal(report.aborted, null, 'a problem of one scenario is not a stop of the run')
    assert.ok(report.usage.apiCalls <= script.AR2_BUDGET.maxApiCalls)
    scenario.check?.(fake, report)
    assertCleanReport(report)
  })
}

// ---- transitions: immediate, delayed, at the edge of the window, never ------------------------------------------------------------------------------------------------------------
const planA = (afterMs: number | null, initial: RefundState = 'pending', to: RefundState = 'succeeded'): Plan => ({ initial, moves: afterMs === null ? [] : [{ afterMs, to }] })
const planB = (afterMs: number | null, initial: RefundState = 'succeeded', to: RefundState = 'failed'): Plan => ({ initial, moves: afterMs === null ? [] : [{ afterMs, to }] })
const A_TIMING_CASES: Array<{ name: string; plan: Plan; t14a: string; t16a: string; becomes: string; pendingHalf: string; check?: (observed: any) => void }> = [
  { name: 'succeeded at once (never pending)', plan: planA(null, 'succeeded'), t14a: 'not_confirmable', t16a: 'not_confirmable', becomes: 'not_confirmable', pendingHalf: 'not_confirmable', check: (o) => assert.equal(o.endedBecause, 'final_state') },
  { name: 'succeeded 3 seconds after the refund, before the first read: the pending state could be measured ONCE only, so the amount while pending is not confirmed (the transition itself was seen)', plan: planA(3_000), t14a: 'confirmed', t16a: 'not_confirmable', becomes: 'confirmed', pendingHalf: 'not_confirmable', check: (o) => assert.deepEqual(o.transition, { from: 'pending', to: 'succeeded', lastSeenBeforeSeconds: 0, firstSeenAfterSeconds: 5 }) },
  { name: 'succeeded after 5 minutes', plan: planA(300_000), t14a: 'confirmed', t16a: 'confirmed', becomes: 'confirmed', pendingHalf: 'confirmed', check: (o) => assert.equal(o.transition.firstSeenAfterSeconds, 300) },
  { name: 'succeeded 1 second before the last read of the window', plan: planA(569_000), t14a: 'confirmed', t16a: 'confirmed', becomes: 'confirmed', pendingHalf: 'confirmed' },
  { name: 'succeeded after the last read of the window (the window is up): NOT confirmed, not contradicted', plan: planA(590_000), t14a: 'not_confirmable', t16a: 'not_confirmable', becomes: 'not_confirmable', pendingHalf: 'confirmed', check: (o) => { assert.equal(o.endedBecause, 'window_ended'); assert.equal(o.finalState, 'pending'); assert.ok(o.observedForSeconds <= 600) } },
  { name: 'never succeeded', plan: planA(null), t14a: 'not_confirmable', t16a: 'not_confirmable', becomes: 'not_confirmable', pendingHalf: 'confirmed', check: (o) => assert.equal(o.endedBecause, 'window_ended') },
  { name: 'requires_action instead of pending, then succeeded', plan: planA(20_000, 'requires_action'), t14a: 'not_confirmable', t16a: 'not_confirmable', becomes: 'not_confirmable', pendingHalf: 'not_confirmable' },
]
for (const scenario of A_TIMING_CASES) {
  test(`SIMULATED: A - ${scenario.name} -> T14A ${scenario.t14a}`, async () => {
    const { report } = await runAr2Fake({ planA: scenario.plan })
    const t14a = factOf(report, 'T14A')
    assert.equal(t14a.status, scenario.t14a, t14a.note)
    assert.equal(partStatus(t14a, 'becomes_succeeded'), scenario.becomes)
    assert.equal(factOf(report, 'T16A').status, scenario.t16a, factOf(report, 'T16A').note)
    assert.equal(partStatus(factOf(report, 'T16A'), 'amount_while_pending'), scenario.pendingHalf)
    scenario.check?.(t14a.observed)
    assert.notEqual(t14a.status, 'contradicted', 'an event that did not happen is never a contradiction')
    // B is not touched by anything A does
    assert.deepEqual(STATE_FACTS_B.map((id) => factOf(report, id).status), ['confirmed', 'confirmed'])
    assert.equal(report.aborted, null)
  })
}

const B_TIMING_CASES: Array<{ name: string; plan: Plan; t14b: string; t16b: string; check?: (observed: any) => void }> = [
  { name: 'failed 1 second after the refund, before the first read: the succeeded state could be measured ONCE only, so T16B is not confirmed (the transition itself was seen)', plan: planB(1_000), t14b: 'confirmed', t16b: 'not_confirmable', check: (o) => assert.deepEqual(o.transition, { from: 'succeeded', to: 'failed', lastSeenBeforeSeconds: 0, firstSeenAfterSeconds: 5 }) },
  { name: 'failed after 8 minutes: the loop did NOT stop at the first succeeded', plan: planB(480_000), t14b: 'confirmed', t16b: 'confirmed', check: (o) => assert.equal(o.transition.firstSeenAfterSeconds, 480) },
  { name: 'failed 1 second before the last read of the window', plan: planB(569_000), t14b: 'confirmed', t16b: 'confirmed' },
  { name: 'failed after the last read of the window: NOT confirmed, not contradicted', plan: planB(590_000), t14b: 'not_confirmable', t16b: 'not_confirmable', check: (o) => { assert.equal(o.endedBecause, 'window_ended'); assert.equal(o.finalState, 'succeeded') } },
  { name: 'never failed (the refund stays succeeded)', plan: planB(null), t14b: 'not_confirmable', t16b: 'not_confirmable' },
  { name: 'failed at once: the refund was created failed (never succeeded)', plan: planB(null, 'failed'), t14b: 'not_confirmable', t16b: 'not_confirmable' },
]
for (const scenario of B_TIMING_CASES) {
  test(`SIMULATED: B - ${scenario.name} -> T14B ${scenario.t14b}`, async () => {
    const { report, fake } = await runAr2Fake({ planB: scenario.plan })
    const t14b = factOf(report, 'T14B')
    assert.equal(t14b.status, scenario.t14b, t14b.note)
    assert.equal(factOf(report, 'T16B').status, scenario.t16b, factOf(report, 'T16B').note)
    scenario.check?.(t14b.observed)
    assert.notEqual(t14b.status, 'contradicted')
    assert.deepEqual(STATE_FACTS_A.map((id) => factOf(report, id).status), ['confirmed', 'confirmed'])
    assert.equal(report.aborted, null)
    // B keeps reading past its first `succeeded`: that is what the scenario is for
    if (scenario.plan.initial === 'succeeded') assert.ok(fake.callLog.filter((call) => call.scenario === 'B' && call.name === 'refunds.retrieve').length >= 3, 'the loop stopped at the first succeeded')
  })
}

test('SIMULATED: a transition too fast for a second measure (A succeeds 3 seconds after its refund, B fails 1 second after it): the ONE reading of the old state stays in the report and is NOT confirmed - the new state, read twice, is', async () => {
  const a = await runAr2Fake({ planA: planA(3_000) })
  const t16a = factOf(a.report, 'T16A')
  const oa = t16a.observed as any
  assert.equal(oa.measures.pending.outcome, 'one_sample')
  assert.equal(oa.measures.pending.samples, 1)
  assert.deepEqual(oa.amountSamplesWhilePending, [20], 'the reading of the pending state was dropped from the report')
  assert.equal(oa.samples.filter((entry: any) => entry.stable && entry.statusBefore === 'pending').length, 1)
  assert.deepEqual([oa.amountWhilePending, oa.pendingRefundCountedInAmountRefunded, oa.successChangedTheAmount], [null, null, null], 'a claim about a pending refund from ONE reading')
  assert.equal(oa.measures.succeeded.outcome, 'settled')
  assert.equal(oa.amountAfterSuccess, 20)
  assert.equal(partStatus(t16a, 'amount_while_pending'), 'not_confirmable')
  assert.match(partDetail(t16a, 'amount_while_pending'), /only one reading/i)
  assert.equal(partStatus(t16a, 'amount_after_success'), 'confirmed')
  assert.equal(t16a.status, 'not_confirmable')
  assert.equal(factOf(a.report, 'T14A').status, 'confirmed', 'the transition itself was seen, and does not depend on the amount')
  assert.equal(a.report.aborted, null)
  const b = await runAr2Fake({ planB: planB(1_000) })
  const t16b = factOf(b.report, 'T16B')
  const ob = t16b.observed as any
  assert.equal(ob.measures.succeeded.outcome, 'one_sample')
  assert.deepEqual(ob.amountSamplesAfterSuccess, [20], 'the reading of the succeeded state was dropped from the report')
  assert.deepEqual([ob.amountAfterSuccess, ob.effectOfTheFailureOnTheAmount, ob.differenceCents], [null, null, null], 'the effect of the failure was claimed from ONE reading before it')
  assert.equal(ob.measures.failed.outcome, 'settled')
  assert.equal(ob.amountAfterFailure, 0)
  assert.equal(t16b.status, 'not_confirmable')
  assert.equal(partStatus(t16b, 'amount_after_success'), 'not_confirmable')
  assert.equal(partStatus(t16b, 'amount_after_failure'), 'confirmed')
  assert.equal(factOf(b.report, 'T14B').status, 'confirmed')
  assertCleanReport(a.report)
  assertCleanReport(b.report)
})

test('SIMULATED: the observation itself still takes the second reading whenever a state lasts: every state that is caught for five seconds or more is measured twice, five seconds apart (what the rule asks of the evaluator, the algorithm already provides)', async () => {
  for (const [name, switches] of [['A pending for 40 s', {}], ['A succeeded at once', { planA: planA(null, 'succeeded') }], ['A succeeded after 5 minutes', { planA: planA(300_000) }], ['B failing after 8 minutes', { planB: planB(480_000) }]] as Array<[string, Switches]>) {
    const { report } = await runAr2Fake(switches)
    for (const id of ['T16A', 'T16B']) {
      const measures = (factOf(report, id).observed as any).measures as Record<string, { outcome: string; samples: number; spanMs: number }>
      for (const [state, measure] of Object.entries(measures)) {
        if (measure.samples === 0) continue
        assert.equal(measure.outcome, 'settled', `${name}: ${id}/${state} was left without its second reading`)
        assert.ok(measure.spanMs >= script.AR2_BUDGET.confirmAfterMs)
      }
    }
  }
})

test('SIMULATED: B reads past the first `succeeded` and stops at the failure: no more reads than needed, and the failure is read with the amount of the charge', async () => {
  const { report, fake } = await runAr2Fake()
  const reads = fake.callLog.filter((call) => call.scenario === 'B' && call.name === 'refunds.retrieve')
  assert.ok(reads.length >= 8, `${reads.length} reads of the refund of B`)
  const last = reads[reads.length - 1]
  const refund = fake.refundOf('B')
  assert.ok(last.at - refund.createdAtMs <= 96_000, 'it kept reading long after the failure had been seen and measured (the failure came at 90 seconds; its amount is read again five seconds later, and that is the end)')
  assert.equal(((factOf(report, 'T16B').observed as any).samples as AsyncRefundSample[]).filter((entry) => entry.stable && entry.statusBefore === 'failed').length, 2, 'the failed state is measured twice, not more')
})

test('SIMULATED: errors that are NOT in a row do not end a scenario: three reads fail, each between two reads that work', async () => {
  const failures: FailSpec[] = [
    { call: 'refunds.retrieve', scenario: 'A', error: 'connection', times: 1, skip: 0 },
    { call: 'refunds.retrieve', scenario: 'A', error: 'connection', times: 1, skip: 1 },
    { call: 'refunds.retrieve', scenario: 'A', error: 'connection', times: 1, skip: 2 },
  ]
  const { report } = await runAr2Fake({ failCall: failures })
  const observed = factOf(report, 'T14A').observed as any
  assert.equal(observed.readErrors.length, 3, 'three reads failed in all')
  assert.notEqual(observed.endedBecause, 'read_errors', 'three errors that were not in a row ended the scenario')
  assert.equal(observed.endedBecause, 'final_state')
  assert.equal(factOf(report, 'T14A').status, 'confirmed')
})

test('SIMULATED: an answer that comes back WITHOUT a state is a failed read, not a state: it is recorded, counted in a row, and three of them end the scenario', async () => {
  const { report } = await runAr2Fake({ stateMissingFor: 'A' })
  const observed = factOf(report, 'T14A').observed as any
  assert.equal(observed.endedBecause, 'read_errors')
  assert.equal(observed.readErrors.length, script.AR2_BUDGET.maxReadErrorsInARow)
  assert.ok(observed.readErrors.every((entry: any) => /without a state/.test(entry.error.message)))
  assert.equal(factOf(report, 'T14A').status, 'not_confirmable')
  assert.deepEqual(STATE_FACTS_B.map((id) => factOf(report, id).status), ['confirmed', 'confirmed'])
})

test('SIMULATED: an unstable sample never ends a scenario: the state changed while the amount was read and Stripe then stops answering - the scenario ends on read errors, not on a "final state" nobody measured', async () => {
  const { report, fake } = await runAr2Fake({ duringAmountRead: { scenario: 'A', nth: 1 }, failCall: [{ call: 'refunds.retrieve', scenario: 'A', error: 'connection', times: 99, skip: 1 }] })
  const observed = factOf(report, 'T14A').observed as any
  assert.equal(observed.endedBecause, 'read_errors')
  assert.equal(factOf(report, 'T16A').status, 'not_confirmable')
  assert.equal(partStatus(factOf(report, 'T16A'), 'amount_after_success'), 'not_confirmable', 'an amount from a sample that changed state was used')
  assert.equal(observed.listing.read, 'not_attempted', 'the reads after the observation were made although the scenario ended on read errors')
  assert.ok(!fake.callLog.some((call) => call.scenario === 'A' && call.name === 'refunds.list'))
})

test('SIMULATED: the confirmation of a final state starts from a FRESH read of the state - if the refund moved on in the meantime the sample is taken in the state it is in, not in the one it was', async () => {
  // A succeeds at 40 seconds (caught at 45) and moves on to failed at 47: the confirmation, five seconds after the first sample, finds it failed
  const { report } = await runAr2Fake({ planA: { initial: 'pending', moves: [{ afterMs: 40_000, to: 'succeeded' }, { afterMs: 47_000, to: 'failed' }] } })
  const observed = factOf(report, 'T16A').observed as any
  assert.equal(observed.unusedSamples, 0, 'a sample was taken with a state that had been read five seconds before')
  assert.deepEqual((factOf(report, 'T14A').observed as any).statesInOrder, ['pending', 'succeeded', 'failed'])
  assert.deepEqual((observed.samples as any[]).map((entry) => entry.statusBefore).slice(-2), ['succeeded', 'failed'])
})

test('SIMULATED: a read may START no later than the end of the window, to the millisecond (reads that last 120.1 seconds each: the sixth would start at 600.5 s and is not made)', async () => {
  const { report, fake } = await runAr2Fake({ planA: planA(null), slowReads: { call: 'refunds.retrieve', scenario: 'A', ms: 120_100 } })
  const refund = fake.refundOf('A')
  const starts = fake.callLog.filter((call) => call.scenario === 'A' && call.name === 'refunds.retrieve' && call.at >= refund.createdAtMs).map((call) => call.at - refund.createdAtMs)
  assert.deepEqual(starts, [0, 120_100, 240_200, 360_300, 480_400], `the starts of the reads: ${starts.join(', ')}`)
  assert.equal((factOf(report, 'T14A').observed as any).endedBecause, 'window_ended')
})

test('SIMULATED: an unexpected failure INSIDE one scenario (an answer that is not an object) leaves that scenario not confirmable, with the error, and the other scenario runs on - it is not a stop of the run', async () => {
  const { report } = await runAr2Fake({ refundAnswersNothingFor: 'A' })
  for (const id of STATE_FACTS_A) {
    const fact = factOf(report, id)
    assert.equal(fact.status, 'not_confirmable', id)
    assert.equal((fact.observed as any).error.type, 'TypeError', 'the error is in the report')
  }
  assert.deepEqual(STATE_FACTS_B.map((id) => factOf(report, id).status), ['confirmed', 'confirmed'], 'B was dragged along')
  assert.equal(factOf(report, 'T13B').status, 'confirmed')
  assert.equal(report.aborted, null, 'an unexpected failure of one scenario stopped the run')
  assert.equal(report.livemodeSeen, false)
  assert.ok(report.facts.some((fact) => fact.id === 'T19'))
  assertCleanReport(report)
})

test('SIMULATED: several events of one type: they are counted, and the time given is that of the FIRST one', async () => {
  // A goes pending -> requires_action (10 s) -> succeeded (40 s): two `refund.updated`
  const { report } = await runAr2Fake({ planA: { initial: 'pending', moves: [{ afterMs: 10_000, to: 'requires_action' }, { afterMs: 40_000, to: 'succeeded' }] } })
  const updated = ((factOf(report, 'T19').observed as any).A.observedTypes as Array<{ type: string; count: number; firstAtSeconds: number }>).find((entry) => entry.type === 'refund.updated')
  assert.deepEqual(updated, { type: 'refund.updated', count: 2, firstAtSeconds: 10 })
  assert.equal(partStatus(factOf(report, 'T19'), 'A_documented_event_observed'), 'confirmed')
  // and the states: the move through requires_action is not the documented pending -> succeeded
  assert.equal(partStatus(factOf(report, 'T14A'), 'becomes_succeeded'), 'not_confirmable')
})

test('SIMULATED: nothing ever happens - both refunds stay as they were for the whole window: the run ends by itself inside the maxima, every fact says what was not seen, no fact is contradicted', async () => {
  const { report, fake } = await runAr2Fake({ planA: planA(null), planB: planB(null) })
  assert.equal(report.aborted, null)
  assert.deepEqual(statuses(report), { T13B: 'confirmed', T14A: 'not_confirmable', T16A: 'not_confirmable', T14B: 'not_confirmable', T16B: 'not_confirmable', T19: 'not_confirmable' })
  assert.ok(report.usage.apiCalls <= script.AR2_BUDGET.maxApiCalls, `calls ${report.usage.apiCalls}`)
  assert.ok(report.usage.apiCalls <= 70, `a refund that never moves needs no more than a few dozen reads: ${report.usage.apiCalls}`)
  assert.ok(report.usage.elapsedMs <= script.AR2_BUDGET.maxRunMs, `time ${report.usage.elapsedMs}`)
  // a scenario watches its refund for at most ten minutes: no read of the refund or of the amount starts later
  for (const scenario of ['A', 'B'] as const) {
    const refund = fake.refundOf(scenario)
    const reads = fake.callLog.filter((call) => call.scenario === scenario && ['refunds.retrieve', 'paymentIntents.retrieve'].includes(call.name) && call.at >= refund.createdAtMs)
    assert.ok(reads.length >= script.AR2_BUDGET.pollScheduleSeconds.length, `${scenario}: ${reads.length} reads`)
    for (const call of reads) assert.ok(call.at - refund.createdAtMs <= script.AR2_BUDGET.observationWindowMs, `${scenario}: a read at ${(call.at - refund.createdAtMs) / 1000} s`)
  }
  for (const id of ['T14A', 'T14B']) assert.equal((factOf(report, id).observed as any).endedBecause, 'window_ended')
  assert.match(factOf(report, 'T14A').note, /States NOT observed:/)
  assertCleanReport(report)
})

test('SIMULATED: a refund that changes state at every single read (flapping): no sample is stable, the samples are capped, nothing is confirmed from them, and the run still ends inside the maxima', async () => {
  // every call takes a second, and the refund changes state every two seconds: the state read before a sample is never the state read after it
  const moves = Array.from({ length: 300 }, (_, index) => ({ afterMs: (index + 1) * 2_000, to: (index % 2 === 0 ? 'requires_action' : 'pending') as RefundState }))
  const { report } = await runAr2Fake({ latencyMs: 1_000, planA: { initial: 'pending', moves } })
  const t16a = factOf(report, 'T16A')
  const observed = t16a.observed as any
  assert.equal(observed.samples.length, script.AR2_BUDGET.maxSamplesPerScenario, 'the samples are capped')
  assert.equal(observed.unusedSamples, script.AR2_BUDGET.maxSamplesPerScenario)
  assert.ok((observed.samples as AsyncRefundSample[]).every((entry) => !entry.stable))
  assert.equal(t16a.status, 'not_confirmable')
  assert.equal(partStatus(t16a, 'amount_while_pending'), 'not_confirmable')
  assert.equal(observed.pendingRefundCountedInAmountRefunded, null)
  assert.equal(factOf(report, 'T14A').status, 'not_confirmable')
  assert.equal(report.aborted, null)
  assert.ok(report.usage.apiCalls <= script.AR2_BUDGET.maxApiCalls)
  assert.deepEqual(STATE_FACTS_B.map((id) => factOf(report, id).status), ['confirmed', 'confirmed'], 'B is not touched by the flapping of A')
})

test('SIMULATED: a slow API cuts the observation at ten minutes by itself: no read of the refund starts after the window, the scenario is not confirmable, and the other scenario still runs', async () => {
  // every read of the refund of A takes a minute: the window is up before the schedule is
  const { report, fake } = await runAr2Fake({ planA: planA(null), slowReads: { call: 'refunds.retrieve', scenario: 'A', ms: 60_000 } })
  const refund = fake.refundOf('A')
  const reads = fake.callLog.filter((call) => call.scenario === 'A' && ['refunds.retrieve', 'paymentIntents.retrieve'].includes(call.name) && call.at >= refund.createdAtMs)
  for (const call of reads) assert.ok(call.at - refund.createdAtMs <= script.AR2_BUDGET.observationWindowMs, `a read at ${(call.at - refund.createdAtMs) / 1000} s`)
  assert.ok(reads.length < script.AR2_BUDGET.pollScheduleSeconds.length, 'the window did not cut anything')
  assert.equal(factOf(report, 'T14A').status, 'not_confirmable')
  assert.equal((factOf(report, 'T14A').observed as any).endedBecause, 'window_ended')
  assert.deepEqual(STATE_FACTS_B.map((id) => factOf(report, id).status), ['confirmed', 'confirmed'])
  assert.equal(report.aborted, null)
})

test('SIMULATED: a Stripe so slow that the run would last more than 25 minutes: the Gate stops it with a budget stop, the report says so, and nothing is called afterwards', async () => {
  const { report, fake } = await runAr2Fake({ latencyMs: 40_000, planA: planA(null), planB: planB(null) })
  assert.match(String(report.aborted), /^budget: The run is longer than 25 minutes/)
  assert.equal(fake.calls.length, report.usage.apiCalls)
  const last = fake.callLog[fake.callLog.length - 1]
  assert.ok(last.at - fake.callLog[0].at <= script.AR2_BUDGET.maxRunMs + 41_000)
  assert.ok(report.usage.apiCalls < script.AR2_BUDGET.maxApiCalls)
})

// ---- the sample: the state of the REFUND and the amount of the CHARGE, read together, and never mixed up ----------------------------------------------------------------------
test('SIMULATED: the state changes WHILE the amount is read (A, at the first sample): that sample is kept apart and not used - nothing is said about a pending refund from it, and the success is still measured', async () => {
  const { report } = await runAr2Fake({ duringAmountRead: { scenario: 'A', nth: 1 } })
  const t16a = factOf(report, 'T16A')
  const observed = t16a.observed as any
  const samples = observed.samples as AsyncRefundSample[]
  const unstable = samples.filter((entry) => !entry.stable)
  assert.equal(unstable.length, 1, JSON.stringify(samples))
  assert.equal(unstable[0].statusBefore, 'pending')
  assert.equal(unstable[0].statusAfter, 'succeeded')
  assert.equal(unstable[0].amountRefunded, 20, 'the amount that belongs to the new state')
  assert.equal(observed.unusedSamples, 1)
  assert.equal(observed.pendingRefundCountedInAmountRefunded, null, 'a claim about pending refunds was made from a sample taken while the state changed')
  assert.equal(observed.amountWhilePending, null)
  assert.equal(partStatus(t16a, 'amount_while_pending'), 'not_confirmable')
  assert.equal(partStatus(t16a, 'amount_after_success'), 'confirmed')
  assert.equal(t16a.status, 'not_confirmable')
  // the states themselves were seen all the same: the state of the refund was read before and after
  assert.equal(factOf(report, 'T14A').status, 'confirmed')
  assert.equal(report.aborted, null)
})

test('SIMULATED: the state changes WHILE the amount is read (B, at the first sample): the amount of the failed refund is not attributed to `succeeded`, so the comparison is NOT made', async () => {
  const { report } = await runAr2Fake({ planB: planB(600_000), duringAmountRead: { scenario: 'B', nth: 1 }, failureDropsTheAmount: true })
  const t16b = factOf(report, 'T16B')
  const observed = t16b.observed as any
  assert.equal(observed.unusedSamples, 1)
  assert.equal(observed.amountAfterSuccess, null, 'the amount read while the state changed was given to `succeeded`')
  assert.equal(observed.amountAfterFailure, 0)
  assert.equal(observed.effectOfTheFailureOnTheAmount, null)
  assert.equal(partStatus(t16b, 'amount_after_success'), 'not_confirmable')
  assert.equal(partStatus(t16b, 'amount_after_failure'), 'confirmed')
  assert.equal(t16b.status, 'not_confirmable')
  assert.equal(factOf(report, 'T14B').status, 'confirmed', 'the failure itself was seen')
})

const AMOUNT_CASES: Array<{ name: string; switches: Switches; counted: unknown; whilePending: number; afterSuccess: number; afterFailure: number; effect: string }> = [
  { name: 'a pending refund is counted, a failed one is taken back', switches: {}, counted: true, whilePending: 20, afterSuccess: 20, afterFailure: 0, effect: 'went_back_down' },
  { name: 'a pending refund is NOT counted, a failed one is taken back', switches: { pendingCounted: false }, counted: false, whilePending: 0, afterSuccess: 20, afterFailure: 0, effect: 'went_back_down' },
  { name: 'a pending refund is counted, a failed one is NOT taken back', switches: { failureDropsTheAmount: false }, counted: true, whilePending: 20, afterSuccess: 20, afterFailure: 20, effect: 'unchanged' },
]
for (const scenario of AMOUNT_CASES) {
  test(`SIMULATED: amount_refunded - ${scenario.name}: both questions are answered and the comparison is explicit`, async () => {
    const { report } = await runAr2Fake(scenario.switches)
    const a = factOf(report, 'T16A').observed as any
    const b = factOf(report, 'T16B').observed as any
    assert.equal(a.pendingRefundCountedInAmountRefunded, scenario.counted)
    assert.equal(a.amountWhilePending, scenario.whilePending)
    assert.equal(a.amountAfterSuccess, scenario.afterSuccess)
    assert.equal(b.amountAfterSuccess, scenario.afterSuccess)
    assert.equal(b.amountAfterFailure, scenario.afterFailure)
    assert.equal(b.effectOfTheFailureOnTheAmount, scenario.effect)
    assert.equal(b.differenceCents, scenario.afterFailure - scenario.afterSuccess)
    assert.deepEqual(STATE_FACTS_A.concat(STATE_FACTS_B).map((id) => factOf(report, id).status), ['confirmed', 'confirmed', 'confirmed', 'confirmed'])
  })
}

test('SIMULATED: the charge is updated a moment AFTER the refund (3 seconds): the two readings of the failed state disagree, so T16B is "not settled" and says so - never a false "unchanged"; the states themselves are still confirmed', async () => {
  const { report } = await runAr2Fake({ amountLagMs: { scenario: 'B', ms: 3_000 } })
  const t16b = factOf(report, 'T16B')
  const observed = t16b.observed as any
  assert.deepEqual(observed.amountSamplesAfterFailure, [20, 0], 'the first reading came before the charge was updated, the second after')
  assert.equal(observed.amountAfterFailure, null)
  assert.equal(observed.effectOfTheFailureOnTheAmount, null)
  assert.equal(partStatus(t16b, 'amount_after_failure'), 'not_confirmable')
  assert.match(partDetail(t16b, 'amount_after_failure'), /do not agree/)
  assert.equal(partStatus(t16b, 'amount_after_success'), 'confirmed')
  assert.equal(t16b.status, 'not_confirmable')
  assert.equal(factOf(report, 'T14B').status, 'confirmed', 'the transition itself does not depend on the amount')
  assert.equal(report.aborted, null)
})

test('SIMULATED: the same lag after the SUCCESS of A (a pending refund that is not counted, a charge updated 8 seconds late): the amount after the success is not settled; the pending half is', async () => {
  const { report } = await runAr2Fake({ pendingCounted: false, amountLagMs: { scenario: 'A', ms: 8_000 } })
  const t16a = factOf(report, 'T16A')
  const observed = t16a.observed as any
  assert.deepEqual(observed.amountSamplesWhilePending, [0, 0])
  assert.equal(observed.pendingRefundCountedInAmountRefunded, false)
  assert.deepEqual(observed.amountSamplesAfterSuccess, [0, 20])
  assert.equal(observed.amountAfterSuccess, null)
  assert.equal(observed.successChangedTheAmount, null)
  assert.equal(partStatus(t16a, 'amount_while_pending'), 'confirmed')
  assert.equal(partStatus(t16a, 'amount_after_success'), 'not_confirmable')
  assert.equal(t16a.status, 'not_confirmable')
  assert.equal(factOf(report, 'T14A').status, 'confirmed')
})

test('SIMULATED: the payment ceases to be `succeeded` once it has the refund: the fact is contradicted for that scenario only', async () => {
  const { report } = await runAr2Fake({ piStatusAfterRefund: { B: 'canceled' } })
  assert.equal(factOf(report, 'T14B').status, 'contradicted')
  assert.equal(partStatus(factOf(report, 'T14B'), 'payment_intent_stays_succeeded'), 'contradicted')
  assert.equal(partStatus(factOf(report, 'T14B'), 'becomes_failed'), 'confirmed', 'the transition itself was seen')
  assert.equal(factOf(report, 'T14A').status, 'confirmed')
})

// ---- the optional fields of a failed refund -----------------------------------------------------------------------------------------------------------------------------
const FAILURE_CASES: Array<{ name: string; switches: Switches; reason: { present: boolean; value: string | null }; transaction: { present: boolean; read: string }; calls: number; check?: (failure: any) => void }> = [  // `calls`: the reads of balance transactions made for B - its own (always) and the one of the failure (when there is one)
  { name: 'everything is there and the balance transaction is readable', switches: {}, reason: { present: true, value: 'unknown' }, transaction: { present: true, read: 'read' }, calls: 2, check: (failure) => { assert.deepEqual(failure.balanceTransaction.details, { type: 'refund_failure', amount: 20, fee: 0, net: 20, category: 'refund_failure', currency: 'eur', sign: 'positive' }); assert.equal(failure.balanceTransaction.error, null) } },
  { name: 'failure_balance_transaction is NULL', switches: { failureBalanceTransaction: 'null' }, reason: { present: true, value: 'unknown' }, transaction: { present: false, read: 'not_present' }, calls: 1, check: (failure) => assert.equal(failure.balanceTransaction.details, null) },
  { name: 'failure_balance_transaction is left out', switches: { failureBalanceTransaction: 'absent' }, reason: { present: true, value: 'unknown' }, transaction: { present: false, read: 'not_present' }, calls: 1 },
  { name: 'failure_reason is null', switches: { failureReason: null }, reason: { present: false, value: null }, transaction: { present: true, read: 'read' }, calls: 2 },
  { name: 'failure_reason is an empty string', switches: { failureReason: '' }, reason: { present: false, value: null }, transaction: { present: true, read: 'read' }, calls: 2 },
  { name: 'failure_reason is left out', switches: { failureReason: 'absent' }, reason: { present: false, value: null }, transaction: { present: true, read: 'read' }, calls: 2 },
  { name: 'a documented reason (lost_or_stolen_card)', switches: { failureReason: 'lost_or_stolen_card' }, reason: { present: true, value: 'lost_or_stolen_card' }, transaction: { present: true, read: 'read' }, calls: 2 },
  { name: 'neither is there', switches: { failureReason: 'absent', failureBalanceTransaction: 'absent' }, reason: { present: false, value: null }, transaction: { present: false, read: 'not_present' }, calls: 1 },
  { name: 'the balance transaction can not be read (permission)', switches: { balanceTransactionError: 'permission' }, reason: { present: true, value: 'unknown' }, transaction: { present: true, read: 'unreadable' }, calls: 2, check: (failure) => { assert.equal(failure.balanceTransaction.details, null); assert.equal(failure.balanceTransaction.error.type, 'StripePermissionError') } },
  { name: 'the balance transaction is not found', switches: { balanceTransactionError: 'not_found' }, reason: { present: true, value: 'unknown' }, transaction: { present: true, read: 'unreadable' }, calls: 2 },
  { name: 'the read of the balance transaction fails with a 500', switches: { balanceTransactionError: 'api' }, reason: { present: true, value: 'unknown' }, transaction: { present: true, read: 'unreadable' }, calls: 2 },
]
for (const scenario of FAILURE_CASES) {
  test(`SIMULATED: a failed refund - ${scenario.name}: recorded apart, and the transition to \`failed\` is confirmed all the same`, async () => {
    const { report, fake } = await runAr2Fake(scenario.switches)
    const t14b = factOf(report, 'T14B')
    assert.equal(t14b.status, 'confirmed', t14b.note)
    assert.equal(partStatus(t14b, 'becomes_failed'), 'confirmed')
    const failure = (t14b.observed as any).failure
    assert.deepEqual(failure.reason, scenario.reason)
    assert.equal(failure.balanceTransaction.present, scenario.transaction.present)
    assert.equal(failure.balanceTransaction.read, scenario.transaction.read)
    scenario.check?.(failure)
    assert.equal(fake.callLog.filter((call) => call.name === 'balanceTransactions.retrieve' && call.scenario === 'B').length, scenario.calls, 'a balance transaction that is not there is not read, and one that is there is read once')
    assert.equal(factOf(report, 'T16B').status, 'confirmed', 'the effect on the amount does not depend on an optional field')
    assert.equal(report.aborted, null)
    assert.ok(!partsOf(t14b).some((entry) => /balance|reason/.test(entry.part)))
    if (!scenario.transaction.present) assert.match(t14b.note, /failure_balance_transaction[^.]*not present|not present[^.]*failure_balance_transaction/i, 'the report says that the field was not there')
    assertCleanReport(report)
  })
}

test('SIMULATED: the balance transaction of the refund ITSELF is recorded apart too (type, amount, fee, net, sign - no id) for both scenarios; when it is not there, is null or can not be read, no verdict changes', async () => {
  const { report } = await runAr2Fake()
  for (const id of ['T14A', 'T14B']) {
    const record = (factOf(report, id).observed as any).refundBalanceTransaction
    assert.equal(record.present, true, id)
    assert.equal(record.read, 'read', id)
    assert.deepEqual(record.details, { type: 'refund', amount: -20, fee: 0, net: -20, category: 'refund', currency: 'eur', sign: 'negative' }, id)
    assert.equal(record.error, null)
    assert.ok(!partsOf(factOf(report, id)).some((entry) => /balance/.test(entry.part)), 'a balance transaction is not a part of a verdict')
    assert.match(factOf(report, id).note, /balance transaction of the refund itself, recorded apart/)
  }
  const baseline = statuses(report)
  for (const refundBalanceTransaction of ['null', 'absent'] as const) {
    const other = await runAr2Fake({ refundBalanceTransaction })
    assert.deepEqual(statuses(other.report), baseline, refundBalanceTransaction)
    assert.equal((factOf(other.report, 'T14B').observed as any).refundBalanceTransaction.present, false)
    assert.equal((factOf(other.report, 'T14B').observed as any).refundBalanceTransaction.read, 'not_present')
    assert.equal(other.fake.callLog.filter((call) => call.name === 'balanceTransactions.retrieve' && call.scenario === 'B').length, 1, 'only the failure balance transaction is read')
  }
  const unreadable = await runAr2Fake({ balanceTransactionError: 'permission' })
  assert.deepEqual(statuses(unreadable.report), baseline)
  assert.equal((factOf(unreadable.report, 'T14A').observed as any).refundBalanceTransaction.read, 'unreadable')
  assert.equal((factOf(unreadable.report, 'T14A').observed as any).refundBalanceTransaction.error.type, 'StripePermissionError')
  // a refund that is still pending has no balance transaction of its own yet: that is said, not read
  const pending = await runAr2Fake({ planA: planA(null) })
  assert.equal((factOf(pending.report, 'T14A').observed as any).refundBalanceTransaction.present, false)
  assert.equal(pending.fake.callLog.filter((call) => call.name === 'balanceTransactions.retrieve' && call.scenario === 'A').length, 0)
  assertCleanReport(report)
})

test('SIMULATED: a pending refund records its `pending_reason` when Stripe gives one, and says nothing when it does not', async () => {
  assert.equal(((await runAr2Fake({ pendingReason: 'insufficient_funds' })).report.facts.find((fact) => fact.id === 'T14A')!.observed as any).pendingReason, 'insufficient_funds')
  assert.equal(((await runAr2Fake({ pendingReason: 'absent' })).report.facts.find((fact) => fact.id === 'T14A')!.observed as any).pendingReason, null)
})

// ---- the events: subscribable (T13B) is not observed (T19) ------------------------------------------------------------------------------------------------------------------
test('SIMULATED: T13B - the three refund event types are asked on a throw-away endpoint, which is deleted at once; the signing secret is never kept', async () => {
  const { report, fake } = await runAr2Fake()
  const t13b = factOf(report, 'T13B')
  assert.equal(t13b.status, 'confirmed')
  const observed = t13b.observed as any
  assert.deepEqual(observed.eventTypesRequested, ['refund.created', 'refund.updated', 'refund.failed'])
  assert.deepEqual(observed.eventTypesEchoed, ['refund.created', 'refund.updated', 'refund.failed'])
  assert.equal(observed.subscribableAll, true)
  assert.deepEqual(observed.missingEvents, [])
  assert.match(t13b.note, /subscribed[^.]*not[^.]*(sent|generated|observed)|SUBSCRIBED/i, 'the note says that subscribable is not observed')
  assert.equal(fake.endpoints.size, 0)
  assert.ok(report.objects.some((object) => object.type === 'webhook_endpoint' && object.cleanup.outcome === 'deleted'))
  assert.ok(!JSON.stringify(report).includes('whsec_'))
})

const T13B_CASES: Array<{ name: string; switches: Switches; status: string; answer?: string }> = [
  { name: 'Stripe refuses an event type (an invalid request about enabled_events)', switches: { rejectEvent: 'refund.failed' }, status: 'contradicted', answer: 'event_types_refused' },
  { name: 'the endpoint comes back without some of the event types', switches: { echoOnly: ['refund.created'] }, status: 'contradicted' },
  { name: 'an invalid request about another parameter (the URL)', switches: { endpointAnswer: 'invalid_request_other_param' }, status: 'not_confirmable', answer: 'other_error' },
  { name: 'a 500', switches: { endpointAnswer: 'api_error' }, status: 'not_confirmable', answer: 'other_error' },
  { name: 'a dropped connection', switches: { endpointAnswer: 'connection_error' }, status: 'not_confirmable', answer: 'other_error' },
  { name: 'a permission error', switches: { endpointAnswer: 'permission_error' }, status: 'not_confirmable', answer: 'other_error' },
]
for (const scenario of T13B_CASES) {
  test(`SIMULATED: T13B - ${scenario.name} -> ${scenario.status}; the other facts are not touched`, async () => {
    const { report, fake } = await runAr2Fake(scenario.switches)
    const t13b = factOf(report, 'T13B')
    assert.equal(t13b.status, scenario.status, JSON.stringify(t13b.observed))
    if (scenario.answer) assert.equal((t13b.observed as any).answer, scenario.answer)
    assert.equal(fake.endpoints.size, 0)
    for (const id of ['T14A', 'T16A', 'T14B', 'T16B', 'T19']) assert.equal(factOf(report, id).status, 'confirmed', id)
    assert.equal(report.aborted, null)
    assertCleanReport(report)
  })
}

const EVENT_CASES: Array<{ name: string; switches: Switches; t19: string; a: { read: string; documented: boolean }; b: { read: string; documented: boolean }; passes?: [number, number]; check?: (observed: any, fake: FakeAr2) => void }> = [
  { name: 'the documented events are generated', switches: {}, t19: 'confirmed', a: { read: 'ok', documented: true }, b: { read: 'ok', documented: true }, passes: [1, 1], check: (o) => { assert.deepEqual(o.A.observedTypes.map((entry: any) => entry.type).sort(), ['charge.refunded', 'refund.created', 'refund.updated']); assert.deepEqual(o.B.observedTypes.map((entry: any) => entry.type).sort(), ['charge.refunded', 'refund.created', 'refund.failed']); assert.equal(o.A.observedTypes.find((entry: any) => entry.type === 'refund.updated').firstAtSeconds, 40); assert.equal(o.B.observedTypes.find((entry: any) => entry.type === 'refund.failed').firstAtSeconds, 90) } },
  { name: 'the deprecated charge.refund.updated is generated too', switches: { deprecatedUpdated: true }, t19: 'confirmed', a: { read: 'ok', documented: true }, b: { read: 'ok', documented: true }, check: (o) => { assert.ok(o.A.observedTypes.some((entry: any) => entry.type === 'charge.refund.updated')); assert.ok(!o.A.notObservedTypes.includes('charge.refund.updated')) } },
  { name: 'refund.updated is never generated for A', switches: { omitEvents: ['refund.updated'] }, t19: 'not_confirmable', a: { read: 'ok', documented: false }, b: { read: 'ok', documented: true }, passes: [2, 1], check: (o) => assert.ok(o.A.notObservedTypes.includes('refund.updated')) },
  { name: 'refund.failed is never generated for B', switches: { omitEvents: ['refund.failed'] }, t19: 'not_confirmable', a: { read: 'ok', documented: true }, b: { read: 'ok', documented: false }, passes: [1, 2] },
  { name: 'no event is generated at all', switches: { events: 'none' }, t19: 'not_confirmable', a: { read: 'ok', documented: false }, b: { read: 'ok', documented: false }, check: (o) => { assert.deepEqual(o.A.observedTypes, []); assert.equal(o.A.notObservedTypes.length, 5) } },
  { name: 'the list is behind at first: the events appear on the second read, 10 seconds later', switches: { lagEventsForFirstReads: 1 }, t19: 'confirmed', a: { read: 'ok', documented: true }, b: { read: 'ok', documented: true }, passes: [2, 1], check: (_o, fake) => { assert.equal(fake.calls.filter((name) => name === 'events.list').length, 3); const reads = fake.callLog.filter((call) => call.name === 'events.list' && call.scenario === null).map((call) => call.at); assert.ok(reads[1] - reads[0] >= script.AR2_BUDGET.eventsSecondReadWaitMs, `the second read of the events came ${(reads[1] - reads[0]) / 1000} seconds after the first`) } },
  { name: 'the list is behind for longer than two reads: the events are not seen', switches: { lagEventsForFirstReads: 9 }, t19: 'not_confirmable', a: { read: 'ok', documented: false }, b: { read: 'ok', documented: false }, passes: [2, 2] },
  { name: 'the events can not be read (a permission error): a read error, not an absent event', switches: { failCall: [{ call: 'events.list', error: 'permission', times: 99 }] }, t19: 'not_confirmable', a: { read: 'unreadable', documented: false }, b: { read: 'unreadable', documented: false }, passes: [1, 1], check: (o, fake) => { assert.equal(o.A.error.type, 'StripePermissionError'); assert.deepEqual(o.A.observedTypes, []); assert.deepEqual(o.A.notObservedTypes, [], 'an unreadable list does not say that an event was absent'); assert.equal(fake.calls.filter((name) => name === 'events.list').length, 2, 'a read that failed is not repeated') } },
  { name: 'the events of A can not be read with a 500, those of B can', switches: { failCall: [{ call: 'events.list', error: 'api', times: 1 }] }, t19: 'not_confirmable', a: { read: 'unreadable', documented: false }, b: { read: 'ok', documented: true } },
]
for (const scenario of EVENT_CASES) {
  test(`SIMULATED: T19 - ${scenario.name} -> ${scenario.t19}`, async () => {
    const { report, fake } = await runAr2Fake(scenario.switches)
    const t19 = factOf(report, 'T19')
    assert.equal(t19.status, scenario.t19, t19.note)
    const observed = t19.observed as any
    assert.equal(observed.A.read, scenario.a.read)
    assert.equal(observed.B.read, scenario.b.read)
    assert.equal(observed.A.documentedEventObserved, scenario.a.documented)
    assert.equal(observed.B.documentedEventObserved, scenario.b.documented)
    assert.equal(partStatus(t19, 'A_documented_event_observed'), scenario.a.documented ? 'confirmed' : 'not_confirmable')
    assert.equal(partStatus(t19, 'B_documented_event_observed'), scenario.b.documented ? 'confirmed' : 'not_confirmable')
    if (scenario.passes) assert.deepEqual([observed.A.passes, observed.B.passes], scenario.passes)
    scenario.check?.(observed, fake)
    // an event that is missing is never a contradiction and never touches the facts about the states
    assert.notEqual(t19.status, 'contradicted')
    assert.deepEqual(['T14A', 'T16A', 'T14B', 'T16B', 'T13B'].map((id) => factOf(report, id).status), ['confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed'])
    assert.equal(report.aborted, null)
    assert.ok(report.usage.apiCalls <= script.AR2_BUDGET.maxApiCalls)
    assertCleanReport(report)
  })
}

test('SIMULATED: T19 tells the three situations apart - an event that was observed, an event that was NOT observed in a list that was read, and a list that could not be read', async () => {
  const observed = factOf((await runAr2Fake()).report, 'T19')
  const missing = factOf((await runAr2Fake({ omitEvents: ['refund.updated'] })).report, 'T19')
  const unreadable = factOf((await runAr2Fake({ failCall: [{ call: 'events.list', error: 'connection', times: 99 }] })).report, 'T19')
  const detail = (fact: FactResult) => partDetail(fact, 'A_documented_event_observed')
  assert.match(detail(observed), /was observed/)
  assert.match(detail(missing), /NOT observed/)
  assert.match(detail(missing), /does not show that Stripe does not generate/)
  assert.match(detail(unreachable(unreadable)), /could not be read/)
  assert.ok(!/NOT observed/.test(detail(unreadable)), 'an unreadable list was described as an absent event')
  assert.ok(!/could not be read/.test(detail(missing)))
  function unreachable(fact: FactResult) { return fact }
})

// ---- read errors in the middle: recorded, never repeated at once, never a verdict ----------------------------------------------------------------------------------------------
test('SIMULATED: a read of the refund that fails in the middle is recorded and the observation goes on at the next scheduled read - the same request is never sent again at once', async () => {
  const { report, fake } = await runAr2Fake({ failCall: [{ call: 'refunds.retrieve', scenario: 'A', error: 'api', times: 1, skip: 2 }] })
  const t14a = factOf(report, 'T14A')
  assert.equal(t14a.status, 'confirmed', t14a.note)
  const reads = ((t14a.observed as any).readErrors) as Array<{ call: string; error: { type: string } }>
  assert.equal(reads.length, 1)
  assert.equal(reads[0].call, 'refunds.retrieve')
  const retrieves = fake.callLog.filter((call) => call.scenario === 'A' && call.name === 'refunds.retrieve')
  const failedAt = retrieves[2].at
  assert.ok(retrieves[3].at > failedAt, 'the failed read was repeated at the same instant')
  assert.equal(report.aborted, null)
})

test('SIMULATED: three reads in a row that fail end that scenario (not confirmable, with the errors in the report) - it does not go on asking a Stripe that does not answer', async () => {
  const { report, fake } = await runAr2Fake({ failCall: [{ call: 'refunds.retrieve', scenario: 'A', error: 'connection', times: 99 }] })
  const t14a = factOf(report, 'T14A')
  assert.equal(t14a.status, 'not_confirmable')
  const observed = t14a.observed as any
  assert.equal(observed.endedBecause, 'read_errors')
  assert.equal(observed.readErrors.length, script.AR2_BUDGET.maxReadErrorsInARow)
  assert.equal(fake.calls.filter((name) => name === 'events.list').length, 1, 'A, which ended on read errors, asks for no events; B asks once')
  assert.deepEqual(STATE_FACTS_B.map((id) => factOf(report, id).status), ['confirmed', 'confirmed'])
  assert.equal(report.aborted, null)
})

// ---- the refund of the list and the report -------------------------------------------------------------------------------------------------------------------------------------
test('SIMULATED: the list of refunds is read once per scenario and recorded as it is (informational: it decides no verdict)', async () => {
  const { report, fake } = await runAr2Fake()
  const a = (factOf(report, 'T14A').observed as any).listing
  const b = (factOf(report, 'T14B').observed as any).listing
  assert.deepEqual([a.read, a.refundsListed, a.statusInTheList], ['ok', 1, 'succeeded'])
  assert.deepEqual([b.read, b.refundsListed, b.statusInTheList], ['ok', 1, 'failed'])
  assert.equal(fake.calls.filter((name) => name === 'refunds.list').length, 2)
  const broken = await runAr2Fake({ failCall: [{ call: 'refunds.list', error: 'permission', times: 99 }] })
  assert.equal((factOf(broken.report, 'T14A').observed as any).listing.read, 'unreadable')
  assert.equal(factOf(broken.report, 'T14A').status, 'confirmed', 'the list decides nothing')
  assert.equal(factOf(broken.report, 'T14B').status, 'confirmed')
})

test('SIMULATED: every object it created is in the report with an observed clean-up outcome; a payment that did not succeed is the only thing canceled; the refunds stay', async () => {
  const { report, fake } = await runAr2Fake()
  assert.equal(report.objects.length, 5, 'two payments, two refunds, one endpoint')
  const outcomes = (type: string) => [...new Set(report.objects.filter((object) => object.type === type).map((object) => object.cleanup.outcome))]
  assert.deepEqual(outcomes('payment_intent'), ['remains'])
  assert.deepEqual(outcomes('refund'), ['remains'])
  assert.deepEqual(outcomes('webhook_endpoint'), ['deleted'])
  for (const object of report.objects) { assert.ok(object.id && object.type && object.step); assert.ok(script.CLEANUP_OUTCOMES.includes(object.cleanup.outcome)) }
  assert.deepEqual([...new Set(report.objects.map((object) => object.step))].sort(), ['AR2-A', 'AR2-B', 'T13B'])
  assert.equal(fake.calls.filter((name) => name === 'paymentIntents.cancel').length, 0, 'a payment that succeeded was asked to be canceled')
  const broken = await runAr2Fake({ piStatus: { B: 'requires_action' } })
  assert.deepEqual(broken.report.objects.filter((object) => object.type === 'payment_intent').map((object) => object.cleanup.outcome).sort(), ['canceled', 'remains'])
  assert.equal(broken.fake.calls.filter((name) => name === 'paymentIntents.cancel').length, 1, 'only the payment that did not succeed is canceled')
  assert.ok(broken.report.objects.every((object) => !object.cleanup.error), 'the clean-up raised no error')
})

test('--only runs just the facts named and only the steps that need them: one scenario, the endpoint alone, or the events (which need both scenarios)', async () => {
  const onlyA = await runAr2Fake({}, { only: ['T14A'] })
  assert.deepEqual(idsOf(onlyA.report), ['T14A', 'T16A'], 'a step answers all its facts')
  assert.deepEqual(onlyA.report.usage.created, { checkout_session: 0, payment_intent: 1, refund: 1, dispute_evidence: 0, webhook_endpoint: 0 })
  assert.ok(!onlyA.fake.calls.includes('webhookEndpoints.create') && !onlyA.fake.calls.includes('events.list'))
  const onlyB = await runAr2Fake({}, { only: ['T16B'] })
  assert.deepEqual(idsOf(onlyB.report), ['T14B', 'T16B'])
  assert.deepEqual(onlyB.fake.paymentRequests.map((request) => request.params.payment_method), [TOKEN_B])
  const endpoint = await runAr2Fake({}, { only: ['T13B'] })
  assert.deepEqual(idsOf(endpoint.report), ['T13B'])
  assert.deepEqual(endpoint.fake.calls, ['webhookEndpoints.create', 'webhookEndpoints.del'])
  const events = await runAr2Fake({}, { only: ['T19'] })
  assert.ok(idsOf(events.report).includes('T19'))
  assert.equal(events.report.usage.created.payment_intent, 2, 'the events of both scenarios need both refunds')
  assert.equal(factOf(events.report, 'T19').status, 'confirmed')
})

// =====================================================================================================================================================================
// 5. The stops: a live-mode object, a maximum reached - everywhere, with nothing called afterwards (not even the clean-up)
// =====================================================================================================================================================================
// ---- the scan for live-mode objects looks at EVERY element of EVERY list ----------------------------------------------------------------------------------------------------------------------
// AR-2 reads lists of up to 100 events. A live-mode object that is the 21st of them, or the 100th, must stop the run exactly as the first one does: a scan of the first twenty lets it through.
const cleanEvents = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `evt_clean_${index}`, object: 'event', type: 'refund.created', created: 1, livemode: false, data: { object: { id: `re_clean_${index}`, livemode: false } } }))
const liveAt = (list: Array<Record<string, unknown>>, index: number) => list.map((entry, place) => (place === index ? { ...entry, livemode: true } : entry))
const GATE_PROFILES: Array<{ name: string; make: () => InstanceType<typeof script.Gate> }> = [
  { name: 'the gate of AR-2', make: () => new script.Gate({}, clock().now, script.AR2_BUDGET) },
  { name: 'the gate of SP1 (the default profile)', make: () => new script.Gate({}, clock().now) },
]
for (const profile of GATE_PROFILES) {
  test(`${profile.name}: a live-mode object is found at ANY place of a list of 100 events - the 1st, 2nd, 20th, 21st, 22nd, 50th, 99th and 100th`, async () => {
    for (const index of [0, 1, 19, 20, 21, 49, 98, 99]) {
      const gate = profile.make()
      await assert.rejects(() => gate.call('events.list', async () => ({ object: 'list', has_more: false, data: liveAt(cleanEvents(100), index) })), script.LivemodeError, `the live-mode object at the place ${index + 1} of 100 went through`)
      assert.equal(gate.calls.length, 1)
    }
  })

  test(`${profile.name}: a list with no live-mode object goes through untouched - empty, 1, 20, 21, 100 and 10 000 events`, async () => {
    for (const size of [0, 1, 20, 21, 100, 10_000]) {
      const answer = { object: 'list', has_more: false, data: cleanEvents(size) }
      assert.equal(await profile.make().call('events.list', async () => answer), answer, `a clean list of ${size}`)
    }
  })

  test(`${profile.name}: the live-mode object is found wherever the lists are - the last of 10 000, the second list of an answer, a list inside an element, a list four levels down, an answer that is itself a list`, async () => {
    const live = (answer: unknown, what: string) => assert.rejects(() => profile.make().call('events.list', async () => answer), script.LivemodeError, what)
    await live({ data: liveAt(cleanEvents(10_000), 9_999) }, 'the last of 10 000')
    await live({ data: cleanEvents(100), other: liveAt(cleanEvents(30), 20) }, 'the 21st of the second list')
    await live({ data: [{ id: 'evt_1', livemode: false, related: liveAt(cleanEvents(40), 30) }] }, 'a list inside an element')
    await live({ data: [{ ...cleanEvents(1)[0], data: { object: { id: 're_x', items: liveAt(cleanEvents(60), 59) } } }] }, 'the 60th of a list that is four levels down')
    await live({ a: [{ b: [{ c: [{ d: [{ livemode: true }] }] }] }] }, 'four levels of lists')
    await live({ groups: [cleanEvents(25), liveAt(cleanEvents(25), 21)] }, 'a list of lists')
    await live(liveAt(cleanEvents(100), 99), 'an answer that is itself a list')
  })
}

test('the scan always ends - on a cyclic answer and on a very deep one - and takes a clean answer for a clean one', async () => {
  const cyclic: any = { object: 'list', data: [] }
  cyclic.data.push(cyclic, { livemode: false, back: cyclic })
  const deep: any = { livemode: false }
  let cursor = deep
  for (let level = 0; level < 5_000; level++) { cursor.next = { livemode: false }; cursor = cursor.next }
  for (const answer of [cyclic, deep]) assert.equal(await new script.Gate({}, clock().now, script.AR2_BUDGET).call('events.list', async () => answer), answer)
})

const LIVE_PLACES: Array<{ place: string; index: number }> = [{ place: '1st', index: 0 }, { place: '21st', index: 20 }, { place: '100th', index: 99 }]
for (const { place, index } of LIVE_PLACES) {
  test(`SIMULATED: a live-mode object at the ${place} place of the 100 events that events.list returns - the run stops there: aborted: livemode, no call afterwards, no clean-up`, async () => {
    // the payment of A does not succeed, so its clean-up (the cancellation of that payment) is waiting at the end of the run: after a stop it must NOT be made
    const { report, fake } = await runAr2Fake({ piStatus: { A: 'requires_action' }, eventsPadding: { total: 100, liveIndex: index } })
    assert.notEqual(fake.stoppedAt, null, 'the fake never handed over the live-mode object')
    assert.equal(report.aborted, 'livemode', `aborted: ${report.aborted}`)
    assert.equal(report.livemodeSeen, true)
    assert.equal(fake.calls.length, fake.stoppedAt, `call(s) made after the stop: ${fake.calls.slice(fake.stoppedAt as number).join(', ')}`)
    assert.equal(fake.calls[fake.calls.length - 1], 'events.list', 'the last call is the list that showed the live-mode object')
    assert.equal(fake.calls.filter((name) => name === 'events.list').length, 1, 'the list was asked for again')
    assert.ok(!fake.calls.includes('paymentIntents.cancel'), 'the clean-up was made after a live-mode object was seen')
    // the step the stop fell in answers nothing (and says that the run stopped); what came before the stop keeps its answer
    for (const id of [...STATE_FACTS_B, 'T19']) {
      const fact = factOf(report, id)
      assert.equal(fact.status, 'not_confirmable', id)
      assert.equal((fact.observed as any).reason, 'livemode', `${id}: the report must say that the run stopped`)
    }
    assert.equal(factOf(report, 'T13B').status, 'confirmed')
    assert.deepEqual(idsOf(report), ALL_AR2)
    assertCleanReport(report)
  })
}

test('SIMULATED: a live-mode object at the 100th place of the list of events that is read for the SECOND scenario: the run stops there, what the first scenario answered keeps its answer, nothing is called afterwards', async () => {
  const { report, fake } = await runAr2Fake({ eventsPadding: { total: 100, liveIndex: 99, liveOnRead: 2 } })
  assert.notEqual(fake.stoppedAt, null)
  assert.equal(report.aborted, 'livemode')
  assert.equal(fake.calls.length, fake.stoppedAt, `call(s) made after the stop: ${fake.calls.slice(fake.stoppedAt as number).join(', ')}`)
  assert.equal(fake.calls.filter((name) => name === 'events.list').length, 2)
  for (const id of ['T13B', ...STATE_FACTS_A]) assert.equal(factOf(report, id).status, 'confirmed', id)
  for (const id of [...STATE_FACTS_B, 'T19']) assert.equal((factOf(report, id).observed as any).reason, 'livemode', id)
})

test('SIMULATED: the control of the tests above - the same 100 events with no live-mode object: the run goes on to its end, the clean-up IS made, and the events that belong to nobody change no verdict', async () => {
  const lonely = await runAr2Fake({ piStatus: { A: 'requires_action' }, eventsPadding: { total: 100 } })
  assert.equal(lonely.report.aborted, null)
  assert.equal(lonely.report.livemodeSeen, false)
  assert.equal(lonely.fake.stoppedAt, null)
  assert.equal(lonely.fake.calls.filter((name) => name === 'paymentIntents.cancel').length, 1, 'the clean-up that a stop must prevent is not even made here')
  assert.equal(lonely.fake.calls.filter((name) => name === 'events.list').length, 1)
  assert.deepEqual(STATE_FACTS_B.map((id) => factOf(lonely.report, id).status), ['confirmed', 'confirmed'])
  const whole = await runAr2Fake({ eventsPadding: { total: 100 } })
  assert.equal(whole.report.aborted, null)
  assert.deepEqual(statuses(whole.report), { T13B: 'confirmed', T14A: 'confirmed', T16A: 'confirmed', T14B: 'confirmed', T16B: 'confirmed', T19: 'confirmed' })
})

test('SIMULATED: through main(), a live-mode object at the 100th place of the list of events ends with exit code 3 - the report is written, says aborted: livemode, and nothing was called afterwards', async () => {
  const fake = new FakeAr2({ piStatus: { A: 'requires_action' }, eventsPadding: { total: 100, liveIndex: 99 } })
  const run = await mainWithPrompt(['--protocol', 'ar2', '--report-dir', '/tmp/never', '--run-id', 'live100x'], 'AR-2', fake)
  assert.equal(run.code, 3, run.out.join('\n'))
  assert.equal(run.written.length, 1)
  const report = JSON.parse(run.written[0].content) as Report
  assert.equal(report.aborted, 'livemode')
  assert.equal(report.livemodeSeen, true)
  assert.notEqual(fake.stoppedAt, null)
  assert.equal(fake.calls.length, fake.stoppedAt)
  assert.ok(!fake.calls.includes('paymentIntents.cancel'))
  assert.ok(run.out.some((line) => line.includes('the run stopped early: livemode')))
})

type StopSite = { name: string; at: { call: string; nth?: number }; switches?: Switches; step: string[]; keeps: string[] }
const STOP_SITES: StopSite[] = [
  { name: 'T13B, the creation of the endpoint', at: { call: 'webhookEndpoints.create' }, step: ['T13B'], keeps: [] },
  { name: 'T13B, the deletion of the endpoint', at: { call: 'webhookEndpoints.del' }, step: ['T13B'], keeps: [] },
  { name: 'A, the payment', at: { call: 'paymentIntents.create', nth: 1 }, step: [...STATE_FACTS_A, ...STATE_FACTS_B, 'T19'], keeps: ['T13B'] },
  { name: 'A, the refund', at: { call: 'refunds.create', nth: 1 }, step: [...STATE_FACTS_A, ...STATE_FACTS_B, 'T19'], keeps: ['T13B'] },
  { name: 'A, the first read of the amount', at: { call: 'paymentIntents.retrieve', nth: 1 }, step: [...STATE_FACTS_A, ...STATE_FACTS_B, 'T19'], keeps: ['T13B'] },
  { name: 'A, a read of the refund in the middle of the observation', at: { call: 'refunds.retrieve', nth: 4 }, step: [...STATE_FACTS_A, ...STATE_FACTS_B, 'T19'], keeps: ['T13B'] },
  { name: 'A, the list of refunds', at: { call: 'refunds.list', nth: 1 }, step: [...STATE_FACTS_A, ...STATE_FACTS_B, 'T19'], keeps: ['T13B'] },
  { name: 'A, the list of events', at: { call: 'events.list', nth: 1 }, step: [...STATE_FACTS_A, ...STATE_FACTS_B, 'T19'], keeps: ['T13B'] },
  { name: 'B, the payment', at: { call: 'paymentIntents.create', nth: 2 }, step: [...STATE_FACTS_B, 'T19'], keeps: ['T13B', ...STATE_FACTS_A] },
  { name: 'B, the refund', at: { call: 'refunds.create', nth: 2 }, step: [...STATE_FACTS_B, 'T19'], keeps: ['T13B', ...STATE_FACTS_A] },
  { name: 'B, a read of the refund after the first succeeded', at: { call: 'refunds.retrieve', nth: 14 }, step: [...STATE_FACTS_B, 'T19'], keeps: ['T13B', ...STATE_FACTS_A] },
  { name: 'A, the read of the balance transaction of the refund itself', at: { call: 'balanceTransactions.retrieve', nth: 1 }, step: [...STATE_FACTS_A, ...STATE_FACTS_B, 'T19'], keeps: ['T13B'] },
  { name: 'B, the read of the failure balance transaction', at: { call: 'balanceTransactions.retrieve', nth: 2 }, step: [...STATE_FACTS_B, 'T19'], keeps: ['T13B', ...STATE_FACTS_A] },
  { name: 'B, the read of the balance transaction of the refund itself', at: { call: 'balanceTransactions.retrieve', nth: 3 }, step: [...STATE_FACTS_B, 'T19'], keeps: ['T13B', ...STATE_FACTS_A] },
  { name: 'B, the list of events', at: { call: 'events.list', nth: 2 }, step: [...STATE_FACTS_B, 'T19'], keeps: ['T13B', ...STATE_FACTS_A] },
  { name: 'B, the refund, while the payment of A (which did not succeed) waits for a clean-up that must NOT run after a stop', at: { call: 'refunds.create', nth: 1 }, switches: { piStatus: { A: 'requires_action' } }, step: [...STATE_FACTS_B, 'T19'], keeps: ['T13B'] },
  { name: 'the clean-up, the cancellation of a payment that did not succeed', at: { call: 'paymentIntents.cancel', nth: 1 }, switches: { piStatus: { B: 'requires_action' } }, step: ['T19'], keeps: ['T13B', ...STATE_FACTS_A] },
]
for (const site of STOP_SITES) {
  for (const stop of ['livemode', 'budget'] as const) {
    test(`SIMULATED: ${stop === 'livemode' ? 'a live-mode object' : 'a maximum reached'} at ${site.name}: the run stops there, nothing is called afterwards, the report says so`, async () => {
      const { report, fake } = await runAr2Fake({ ...site.switches, stopAt: { ...site.at, stop } })
      assert.notEqual(fake.stoppedAt, null, 'the stop was not injected where it was meant to be')
      assert.equal(stop === 'livemode' ? report.aborted : String(report.aborted).split(':')[0], stop, `aborted: ${report.aborted}`)
      assert.equal(report.livemodeSeen, stop === 'livemode')
      // NOTHING is called after the stop - no further step, no read of events, no clean-up
      assert.equal(fake.calls.length, fake.stoppedAt, `call(s) made after the stop: ${fake.calls.slice(fake.stoppedAt as number).join(', ')}`)
      // the step the stop fell in does not answer its questions with a verdict from the stop (it is "not confirmable", and says that the run stopped)
      for (const id of site.step) {
        const fact = factOf(report, id)
        assert.equal(fact.status, 'not_confirmable', `${id} was answered by a stop`)
        assert.equal((fact.observed as any).reason ?? (fact.observed as any).stoppedBecause, report.aborted, `${id}: the report must say that the run stopped`)
      }
      for (const id of site.keeps) assert.equal(factOf(report, id).status, 'confirmed', `${id}: what came before the stop keeps its answer`)
      assert.deepEqual(idsOf(report), ALL_AR2)
      assertCleanReport(report)
    })
  }
}

test('SIMULATED: a maximum reached for real (the run lasts longer than allowed): the Gate itself refuses the next call, the run stops with "budget:", and nothing is called afterwards - the endpoint is already deleted', async () => {
  const { report, fake } = await runAr2Fake({ stopAt: { call: 'refunds.create', stop: 'clock', nth: 1 } })
  assert.match(String(report.aborted), /^budget: The run is longer than \d+ minutes/)
  assert.equal(fake.calls.length, fake.stoppedAt, 'a call was made after the maximum was reached')
  assert.equal(factOf(report, 'T13B').status, 'confirmed')
  assert.equal(factOf(report, 'T14A').status, 'not_confirmable')
  assert.equal(fake.endpoints.size, 0)
})

test('SIMULATED: through main(), a live-mode object ends with exit code 3 and a maximum with a report that says the run stopped early - the report is written either way, under the name of AR-2', async () => {
  for (const [stop, code] of [['livemode', 3], ['budget', 0]] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ar2-stop-'))
    const time = clock()
    const fake = new FakeAr2({ stopAt: { call: 'refunds.retrieve', stop, nth: 3 } }, time)
    const out: string[] = []
    const written: string[] = []
    const exit = await script.main(['--protocol', 'ar2', '--report-dir', dir, '--run-id', 'ar2stop1'], { STRIPE_SECRET_KEY: FAKE_KEY }, {
      say: (line) => out.push(line), createClient: () => asClient(fake, time), now: time.now, sleep: time.sleep, repoRoot: '/work/repo', prompt: async () => 'AR-2', writeReport: (file, content) => { written.push(path.basename(file)); written.push(content) },
    })
    assert.equal(exit, code, stop)
    assert.equal(written.length, 2, `${stop}: the report is written`)
    assert.equal(written[0], 'stripe-test-mode-verify-ar2-ar2stop1.json')
    const report = JSON.parse(written[1])
    assert.equal(stop === 'livemode' ? report.aborted : String(report.aborted).split(':')[0], stop)
    assert.equal(fake.calls.length, fake.stoppedAt, `${stop}: a call was made after the stop`)
    assert.ok(out.some((line) => line.includes('the run stopped early')), `${stop}: the owner is told that the run stopped`)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AR-2 reuses the stop of SP1: `run` called with the AR-2 protocol is AR-2, and `runAr2` refuses to run under any other protocol', async () => {
  const fake = new FakeAr2()
  const time = clock()
  await assert.rejects(() => script.runAr2(clientOf(fake), { ...ar2Options(), protocol: 'sp1' }, { now: time.now, sleep: time.sleep, say: () => undefined, prompt: async () => '' }), /--protocol ar2/)
  await assert.rejects(() => script.runAr2(clientOf(fake), { ...ar2Options(), protocol: undefined }, { now: time.now, sleep: time.sleep, say: () => undefined, prompt: async () => '' }), /--protocol ar2/)
  assert.equal(fake.calls.length, 0, 'a call was made although the protocol was not selected')
})

// =====================================================================================================================================================================
// 6. The report: sanitised, outside the repository, and nothing secret anywhere
// =====================================================================================================================================================================
test('the report of AR-2: the shape, the profile it was run under, the call log - written under its own name, mode 0600, outside the repository, with nothing secret in the file or on the screen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ar2-report-'))
  const time = clock()
  const fake = new FakeAr2({}, time)
  const out: string[] = []
  const prompts: string[] = []
  const code = await script.main(['--protocol', 'ar2', '--report-dir', path.join(dir, 'nested'), '--run-id', 'report02'], { STRIPE_SECRET_KEY: FAKE_KEY }, {
    say: (line) => out.push(line), createClient: () => asClient(fake, time), now: time.now, sleep: time.sleep, repoRoot: '/work/repo', prompt: async (question) => { prompts.push(question); return 'AR-2' },
  })
  assert.equal(code, 0, out.join('\n'))
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Type AR-2 to go on/)
  const file = path.join(dir, 'nested', 'stripe-test-mode-verify-ar2-report02.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(dir, 'nested')).mode & 0o777, 0o700)
  const json = fs.readFileSync(file, 'utf8')
  const report = JSON.parse(json) as Report & { protocol?: string; version?: number }
  assert.equal(report.protocol, 'ar2')
  assert.equal(report.tool, 'stripe-test-mode-verify')
  assert.equal(report.runId, 'report02')
  assert.deepEqual(report.facts.map((fact) => fact.id), ALL_AR2)
  assert.deepEqual(report.budget, JSON.parse(JSON.stringify(script.AR2_BUDGET)))
  assert.equal(report.calls.length, report.usage.apiCalls)
  assert.deepEqual(report.summary, { confirmed: 6, contradicted: 0, not_confirmable: 0 })
  const everything = `${json}\n${out.join('\n')}`
  for (const secret of [FAKE_KEY, 'SHOULD_NEVER_BE_KEPT', 'SHOULD_NOT_BE_KEPT', 'receipts/SECRET', 'buyer@example.test', 'RCPT-SECRET', '4242', 'FPRINT', 'client_secret', 'receipt_url', 'whsec_', 'txn_fake_for_']) assert.ok(!everything.includes(secret), `"${secret}" leaked`)
  assert.ok(out.some((line) => line.includes(file)), 'the owner is told where the report is')
  assert.ok(out.some((line) => /Done\. Confirmed: 6/.test(line)))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a secret-shaped string that slipped into a field the script copies as it is stops the write of the AR-2 report (exit 1, no file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ar2-leak-'))
  const written: string[] = []
  const output: string[] = []
  const time = clock()
  const fake = new FakeAr2({ secretInAField: 'whsec_ABCDEFGH0123' }, time)
  const code = await script.main(['--protocol', 'ar2', '--report-dir', dir, '--run-id', 'lastchk2'], { STRIPE_SECRET_KEY: FAKE_KEY }, {
    say: (line) => output.push(line), createClient: () => asClient(fake, time), now: time.now, sleep: time.sleep, repoRoot: '/work/repo', prompt: async () => 'AR-2', writeReport: (file) => { written.push(file) },
  })
  assert.equal(code, 1, output.join('\n'))
  assert.deepEqual(written, [])
  assert.match(output.join('\n'), /NOT written/)
  assert.ok(!output.join('\n').includes('whsec_ABCDEFGH0123'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('every report AR-2 can produce passes the last check of the report - in the documented run and in every variation of the fake', async () => {
  const variations: Switches[] = [
    {}, { planA: planA(null), planB: planB(null) }, { events: 'none' }, { failCall: [{ call: 'events.list', error: 'permission', times: 99 }] }, { failureBalanceTransaction: 'null' }, { failureBalanceTransaction: 'absent', failureReason: 'absent' },
    { balanceTransactionError: 'permission' }, { piStatus: { A: 'requires_action' } }, { duringAmountRead: { scenario: 'A', nth: 1 } }, { echoOnly: ['refund.created'] }, { endpointAnswer: 'api_error' },
    { planA: { initial: 'a_state_nobody_knows', moves: [] } }, { failCall: [PAYMENT_OF('A'), REFUND_OF('B')] }, { stopAt: { call: 'refunds.retrieve', stop: 'livemode', nth: 5 } }, { latencyMs: 3_000 },
  ]
  for (const switches of variations) {
    const { report } = await runAr2Fake(switches)
    assertCleanReport(report)
    for (const fact of report.facts) {
      assert.ok(['confirmed', 'contradicted', 'not_confirmable'].includes(fact.status), fact.id)
      if (partsOf(fact).length > 0) checkParts(fact)
    }
    assert.ok(report.usage.apiCalls <= script.AR2_BUDGET.maxApiCalls, JSON.stringify(switches))
    assert.ok(report.usage.created.payment_intent <= 2 && report.usage.created.refund <= 2 && report.usage.created.webhook_endpoint <= 1, JSON.stringify(switches))
    assert.ok(report.usage.amountCents <= 200)
  }
})

// =====================================================================================================================================================================
// 7. The source of the script: what it can reach, and that it never repeats a request
// =====================================================================================================================================================================
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/stripe-test-mode-verify.ts'), 'utf8')
const AR2_SOURCE = (() => {
  const begin = SOURCE.indexOf('<<AR-2 begin>>')
  const end = SOURCE.indexOf('<<AR-2 end>>')
  return begin >= 0 && end > begin ? stripComments(SOURCE.slice(begin, end)) : ''
})()

test('the source: the AR-2 part is delimited, calls only what the profile allows, and creates nothing the profile forbids', () => {
  assert.ok(AR2_SOURCE.length > 2000, 'the AR-2 part of the script was not found (its markers are <<AR-2 begin>> and <<AR-2 end>>)')
  const names = [...new Set([...AR2_SOURCE.matchAll(/gate\.call\(\s*'([A-Za-z.]+)'/g)].map((match) => match[1]))].sort()
  assert.ok(names.length >= 6, `the scan found ${names.join(', ')}`)
  const allowed = new Set<string>(script.AR2_BUDGET.allowedCalls)
  for (const name of names) assert.ok(allowed.has(name), `the AR-2 part calls ${name}, which the profile does not allow`)
  for (const forbidden of ['customers.', 'products.', 'prices.', 'invoices.', 'invoiceItems.', 'paymentLinks.', 'checkout.', 'disputes.', 'testHelpers', 'subscriptions.', 'accounts.', 'transfers.', 'payouts.', 'refunds.cancel', 'paymentIntents.capture', 'paymentIntents.search']) {
    assert.ok(!AR2_SOURCE.includes(forbidden), `the AR-2 part uses ${forbidden}`)
  }
  assert.ok(!/maxNetworkRetries:\s*[1-9]/.test(SOURCE) && /maxNetworkRetries: 0/.test(SOURCE))
})

test('the source: each creation is sent from ONE place, and nothing in AR-2 sends a request again - no retry loop, no timer, no unbounded loop', () => {
  for (const creation of ['refunds.create(', 'paymentIntents.create(', 'webhookEndpoints.create(']) assert.ok((AR2_SOURCE.match(new RegExp(creation.replace(/[().]/g, '\\$&'), 'g')) ?? []).length <= 1, `${creation} is sent from more than one place in AR-2`)
  assert.equal((AR2_SOURCE.match(/refunds\.create\(/g) ?? []).length, 1)
  for (const loopholed of [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/, /setInterval|setTimeout/, /\bretry\b|\bretries\b|\bbackoff\b/i, /\.catch\(/, /Promise\.(all|race|any|allSettled)\(/]) assert.ok(!loopholed.test(AR2_SOURCE), `AR-2 contains ${loopholed}`)
  // the loops there are: the schedule, the two reads of the events, and the samples (capped)
  const loops = [...AR2_SOURCE.matchAll(/\b(for|while)\s*\(([^)]*)\)/g)].map((match) => `${match[1]} (${match[2]})`)
  for (const loop of loops) assert.ok(/pollScheduleSeconds|pass <= |maxSamplesPerScenario|\bof\b|\bin\b/.test(loop), `an unbounded loop in AR-2: ${loop}`)
})

test('the source: every catch of AR-2 lets a stop of the script through, like every catch of SP1', () => {
  const catches = [...AR2_SOURCE.matchAll(/\bcatch\b\s*(?:\([^)]*\))?\s*\{/g)]
  assert.ok(catches.length >= 5, `the scan found ${catches.length} catch blocks in AR-2`)
  for (const match of catches) {
    const body = AR2_SOURCE.slice(match.index as number, (match.index as number) + 400)
    assert.ok(/stopOnOwnStop\(|instanceof LivemodeError/.test(body), `a catch of AR-2 that reads an error without letting a stop through: ${body.slice(0, 120)}`)
  }
})

test('the source: the scan for live-mode objects takes EVERY element of a list - no slice, no cap on the number of elements - and keeps its limit of depth', () => {
  const start = SOURCE.indexOf('function containsLivemode')
  assert.ok(start > 0, 'containsLivemode was not found')
  const end = SOURCE.indexOf('\n}\n', start)
  assert.ok(end > start)
  const body = stripComments(SOURCE.slice(start, end + 3))
  assert.ok(body.length > 150 && body.includes('livemode'), body)
  assert.ok(!/\.slice\(|\.splice\(|\.length\s*[<>]=?\s*\d|\.at\(|\.filter\(|\.find\(/.test(body), `the scan looks at a part of a list only: ${body}`)
  assert.match(body, /Array\.isArray\([^)]*\)[\s\S]*\.some\(/, 'the scan does not go through the elements of a list')
  assert.match(body, /depth\s*>\s*\d+/, 'the limit of depth is gone: a cyclic answer would never end')
})

test('the source: the typed confirmation is decided in ONE place, `needsTypedConfirmation`, and main() has no other way to skip the question', () => {
  const main = SOURCE.slice(SOURCE.indexOf('export async function main'))
  assert.match(main, /needsTypedConfirmation\(options\)/, 'main() does not ask the helper')
  assert.ok(!/options\.yes\b/.test(stripComments(main)), 'main() reads options.yes itself: the question can be skipped on it')
  assert.match(SOURCE, /export\s+(function|const)\s+needsTypedConfirmation/)
})

// =====================================================================================================================================================================
// 8. The guide agrees with the code
// =====================================================================================================================================================================
test('the guide (docs/STRIPE-TEST-MODE-S6.md, section 11) describes AR-2: the facts, the same maxima as the code, the differences from SP1, the Windows steps, what stays in Stripe', () => {
  const guide = fs.readFileSync(path.join(process.cwd(), 'docs/STRIPE-TEST-MODE-S6.md'), 'utf8')
  const start = guide.search(/^## 11\./m)
  assert.ok(start > 0, 'the guide has no section 11 for AR-2')
  const section = guide.slice(start)
  for (const id of ALL_AR2) assert.ok(new RegExp(`\\b${id}\\b`).test(section), `${id} is not in the AR-2 section`)
  for (const word of [TOKEN_A, TOKEN_B, '--protocol ar2', 'AR-2', '--dry-run', '--report-dir', 'rk_test_', 'Read-Host', '$env:STRIPE_SECRET_KEY', 'Remove-Item Env:STRIPE_SECRET_KEY', 'PowerShell', 'failure_balance_transaction', 'not_confirmable', 'stripe-test-mode-verify-ar2-']) assert.ok(section.includes(word), `${word} is not in the AR-2 section`)
  const budget = script.AR2_BUDGET
  for (const number of [budget.paymentIntents, budget.refunds, budget.webhookEndpoints, budget.maxApiCalls, budget.maxRunMs / 60000, budget.observationWindowMs / 60000, (budget.maxAmountCentsTotal / 100).toFixed(2), (budget.maxRefundAmountCents / 100).toFixed(2), (budget.maxAmountCentsPerPayment / 100).toFixed(2)]) {
    assert.ok(section.includes(String(number)), `the maximum ${number} is not in the AR-2 section`)
  }
  // the maxima in the TABLE of 11.6, row by row (a number that happens to appear elsewhere in the section does not count)
  const minutes = (ms: number) => String(ms / 60000)
  for (const row of [
    `| Denaro di prova | **${(budget.maxAmountCentsPerPayment / 100).toFixed(2)}** per pagamento, **${(budget.maxAmountCentsTotal / 100).toFixed(2)}** in totale |`,
    `| PaymentIntent (pagamenti) | **${budget.paymentIntents}** |`,
    `| Rimborsi | **${budget.refunds}**, ciascuno da **${(budget.maxRefundAmountCents / 100).toFixed(2)}** al massimo`,
    `| Endpoint webhook (creato e cancellato subito) | **${budget.webhookEndpoints}** |`,
    `| Chiamate all'API di Stripe | **${budget.maxApiCalls}** |`,
    `| Durata totale | **${minutes(budget.maxRunMs)}** minuti |`,
    `| Osservazione di ciascun rimborso | **${minutes(budget.observationWindowMs)}** minuti per scenario |`,
    `| Sessioni di Checkout | ${budget.checkoutSessions} |`,
  ]) assert.ok(section.includes(row), `the table of the maxima has no row: ${row}`)
  assert.match(section, /Differenze|differenze/)
  assert.match(section, /0600/)
  assert.ok(!/AR-2[^.]*superat[ao]/.test(section), 'AR-2 is not declared passed')
  // the first section of the guide still describes SP1, and says that AR-2 is another protocol
  assert.match(guide.slice(0, start), /AR-2/)
})

test('the guide says what SP1-quater-bis changed: --yes is refused with AR-2 (the table of the options and the step that starts AR-2), a measure needs two readings at least 5 seconds apart that agree, and every element of a list is checked for a live-mode object', () => {
  const guide = fs.readFileSync(path.join(process.cwd(), 'docs/STRIPE-TEST-MODE-S6.md'), 'utf8')
  const section = guide.slice(guide.search(/^## 11\./m))
  const row = guide.split('\n').find((line) => /^\|\s*`--yes`\s*\|/.test(line)) ?? ''
  assert.match(row, /rifiutat[ao]/, 'the row of --yes in the table of the options does not say that it is refused with AR-2')
  assert.match(row, /--protocol ar2/)
  assert.match(row, /AR-2/)
  assert.match(row, /YES/, 'the row of --yes must still say what it does for SP1')
  assert.match(section, /--yes[^\n]*rifiutat[ao]/i, 'the AR-2 section does not say that --yes is refused')
  assert.match(section, /sempre[^\n]*`AR-2`|`AR-2`[^\n]*sempre/, 'the AR-2 section does not say that the word AR-2 is always asked')
  // the rule of a measure is ONE bullet of 11.4, and it must say all of it (not scattered over the section)
  const rule = section.split('\n').find((line) => /almeno due letture stabili/i.test(line)) ?? ''
  assert.ok(rule, 'the AR-2 section does not say that a measure needs at least two stable readings')
  assert.match(rule, /almeno 5 secondi/, 'the rule does not give the gap between the two readings')
  assert.match(rule, /Una sola lettura/, 'the rule does not say that ONE reading confirms nothing')
  assert.match(rule, /meno di 5 secondi/, 'the rule does not say that two readings closer than the gap confirm nothing')
  assert.match(rule, /differiscono/, 'the rule does not say that readings that differ confirm nothing')
  assert.match(rule, /conserva/, 'the rule does not say that the readings stay in the report')
  assert.match(rule, /non\W+la dichiara confermata/, 'the rule does not say that the measure is not declared confirmed')
  assert.match(section, /ogni elemento|tutti gli elementi/i, 'the guide does not say that every element of a list is checked for a live-mode object')
})
