// Step 4.6, S6, P3a.1 - the FAKE Stripe of the tests of lib/stripe-funds-reader.ts. (Not a test file: its name does not match the test patterns.)
//
// WHAT IT IS: a deterministic, READ-ONLY, in-memory stand-in for the four Stripe calls the reader makes - `paymentIntents.retrieve`, `refunds.list`, `disputes.list`,
// `balanceTransactions.retrieve` - with a controllable clock, a history of events that fire "before the k-th call of a method", a log of every call (parameters and options as
// received), a registry of everything it returned, and injected faults (errors built by the REAL Stripe SDK classes, malformed answers, answers that never arrive).
// WHAT IT IS NOT: Stripe. Every object here is BUILT, shaped after what the SDK documents and after what the owner's Test Mode runs OBSERVED (docs/VERIFICA-4.6.md S6a.17-S6a.19).
// Nothing is fetched from Stripe; no function here opens a connection, reads a file, the environment or a real clock. `Stripe` is imported only to build its error objects and,
// in the wire tests, to be the REAL client over a fake `httpClient`.
//
// WHAT IT KEEPS FAITHFUL (and tests/stripe-funds-reader.test.ts proves it, section Z0, independently of the reader): lists are newest first, `limit` is 1..100 (default 10),
// `starting_after` must name an object of the list, a cursor is a position (an object born after it sits BEFORE it and is never shown by later pages); a list called with the
// filters and the options in ONE object loses every filter (the SDK's own trap: the request goes out unfiltered); unknown parameters are refused; `amount_refunded` follows the
// refunds (pending ones are inside it, a failed one is not; `requires_action` is configurable) and `disputed` is sticky; balance transactions are immutable and resolvable by id
// only; a dispute carries its balance transactions inline; a client that honors `timeout` fails with the SDK's own timeout error.
import Stripe from 'stripe'

export const FAKE_KEY = 'sk_test_FAKEOFF1234'
export type Rec = Record<string, any>
export type Method = 'paymentIntents.retrieve' | 'refunds.list' | 'disputes.list' | 'balanceTransactions.retrieve'
export const METHODS: readonly Method[] = ['paymentIntents.retrieve', 'refunds.list', 'disputes.list', 'balanceTransactions.retrieve']

// ---- a seeded generator (no clock, no Math.random: a failure can always be replayed) -----------------------------------------------------------------------------------
export type Random = () => number
export function mulberry32(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const between = (random: Random, min: number, max: number) => min + Math.floor(random() * (max - min + 1))
export const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]
export function shuffled<T>(random: Random, items: readonly T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const held = copy[index]
    copy[index] = copy[other]
    copy[other] = held
  }
  return copy
}

// ---- strings that must NEVER reach the evidence or the report (personal data and secrets, planted in every object the fake returns) ----------------------------------
export const CANARIES = {
  clientSecret: 'CANARY_CLIENT_SECRET_7f3a9',
  email: 'canary.person@example.invalid',
  name: 'CANARY PERSON NAME',
  phone: '+390000CANARY',
  street: 'CANARY STREET 1',
  receipt: 'https://pay.example.invalid/receipts/CANARY_RECEIPT',
  evidence: 'CANARY_DISPUTE_EVIDENCE_TEXT',
  metadata: 'CANARY_METADATA_VALUE',
  fingerprint: 'CANARY_CARD_FINGERPRINT',
  errorText: 'CANARY_ERROR_MESSAGE_TEXT',
} as const
export const CANARY_VALUES: string[] = Object.values(CANARIES)

// ---- a virtual clock ----------------------------------------------------------------------------------------------------------------------------------------------------
export function virtualClock(start = 1_800_000_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms }, set: (value: number) => { t = value } }
}
export type VirtualClock = ReturnType<typeof virtualClock>

// ---- copies and read-only views ------------------------------------------------------------------------------------------------------------------------------------------
export const clone = <T>(value: T): T => {
  try { return structuredClone(value) } catch { return '[uncloneable]' as unknown as T }
}
// A deep READ-ONLY view of a response: reading goes through, every attempt to write is recorded (even in sloppy mode, where a frozen object would only ignore it) and refused.
export function readOnlyView<T>(value: T, onAttempt: (what: string) => void): T {
  if (value === null || typeof value !== 'object') return value
  const cache = new WeakMap<object, unknown>()
  const refuse = (what: string): never => {
    onAttempt(what)
    throw new TypeError(`a response of the fake Stripe is read-only: ${what}`)
  }
  const wrap = (target: any): any => {
    if (target === null || typeof target !== 'object') return target
    const known = cache.get(target)
    if (known !== undefined) return known
    const proxy = new Proxy(target, {
      get: (inner, property, receiver) => wrap(Reflect.get(inner, property, receiver)),
      set: (_inner, property) => refuse(`set ${String(property)}`),
      defineProperty: (_inner, property) => refuse(`define ${String(property)}`),
      deleteProperty: (_inner, property) => refuse(`delete ${String(property)}`),
      setPrototypeOf: () => refuse('setPrototypeOf'),
    })
    cache.set(target, proxy)
    return proxy
  }
  return wrap(value)
}

// ---- errors, built by the REAL SDK classes (constructed only: nothing touches the network) ------------------------------------------------------------------------------
export const sdkErrors = {
  rateLimit: () => new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: CANARIES.errorText, statusCode: 429 }),
  api: () => Stripe.errors.StripeError.generate({ type: 'api_error', message: CANARIES.errorText, statusCode: 500 }),
  permission: () => new Stripe.errors.StripePermissionError({ type: 'invalid_request_error', message: CANARIES.errorText, statusCode: 403 }),
  authentication: () => new Stripe.errors.StripeAuthenticationError({ type: 'authentication_error', message: CANARIES.errorText, statusCode: 401 }),
  notFound: (what = 'object', id = 'x') => Stripe.errors.StripeError.generate({ type: 'invalid_request_error', code: 'resource_missing', message: `No such ${what}: '${id}' ${CANARIES.errorText}`, statusCode: 404 }),
  invalidRequest: (message: string = CANARIES.errorText) => Stripe.errors.StripeError.generate({ type: 'invalid_request_error', message, statusCode: 400 }),
  connection: () => new Stripe.errors.StripeConnectionError({ message: CANARIES.errorText } as any),
  timeout: (ms = 5000) => new Stripe.errors.StripeConnectionError({ message: `Request aborted due to timeout being reached (${ms}ms) ${CANARIES.errorText}`, detail: (Stripe as any).HttpClient.makeTimeoutError() } as any),
}

// ---- how a call ends ------------------------------------------------------------------------------------------------------------------------------------------------------
export type Outcome = { type: 'value'; value: unknown } | { type: 'reject'; error: unknown } | { type: 'throw'; error: unknown } | { type: 'never' }
export const ok = (value: unknown): Outcome => ({ type: 'value', value })
export const rejectWith = (error: unknown): Outcome => ({ type: 'reject', error })
export const throwSync = (error: unknown): Outcome => ({ type: 'throw', error })
export const never = (): Outcome => ({ type: 'never' })
export type CallInfo = { n: number; nth: number; method: Method; id: string | undefined; params: any; options: any; atMs: number }
export type Rule = { match: (call: CallInfo) => boolean; act: (call: CallInfo, normal: () => Outcome) => Outcome; label?: string }
export type Returned = { n: number; nth: number; method: Method; id: string | undefined; response?: unknown; error?: string; never?: boolean }
export type Anchor = 'T0' | 'T1' | 'T2' | 'T3' | { method: Method; nth: number }
// T0 before the first read of the payment, T1 before the first list of refunds, T2 before the first list of disputes, T3 before the second read of the payment (the closing one)
export const ANCHORS: Record<'T0' | 'T1' | 'T2' | 'T3', { method: Method; nth: number }> = {
  T0: { method: 'paymentIntents.retrieve', nth: 1 },
  T1: { method: 'refunds.list', nth: 1 },
  T2: { method: 'disputes.list', nth: 1 },
  T3: { method: 'paymentIntents.retrieve', nth: 2 },
}

// the options the SDK recognises as REQUEST OPTIONS (an object that holds one of them is taken as options and its other keys are ignored)
const OPTION_KEYS = ['apiKey', 'idempotencyKey', 'stripeAccount', 'stripeContext', 'apiVersion', 'maxNetworkRetries', 'timeout', 'host', 'authenticator', 'headers', 'settings', 'streaming']
const LIST_KEYS = ['payment_intent', 'charge', 'limit', 'starting_after', 'ending_before', 'created', 'expand']
const merge = (base: Rec, over: Rec): Rec => {
  const out: Rec = { ...base }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  return out
}

// ---- the world ------------------------------------------------------------------------------------------------------------------------------------------------------------
export type WorldOptions = {
  pi?: string
  livemode?: boolean
  amount?: number
  amountReceived?: number
  currency?: string
  status?: string
  charge?: string | null   // the id of the latest charge; null = the payment has none (`latest_charge: null`)
  latencyMs?: number       // virtual time every call takes (default 40)
}
export type RefundSpec = { id?: string; amount?: number; status?: string; currency?: string; debit?: boolean; reversal?: boolean; fee?: number; over?: Rec }
export type DisputeSpec = { id?: string; amount?: number; status?: string; currency?: string; withdrawn?: number | false; reinstated?: number | false; fee?: number; over?: Rec }
export type FakeClient = {
  paymentIntents: { retrieve(id: string, params: { expand: string[] }, options?: { timeout?: number; maxNetworkRetries?: number }): Promise<unknown> }
  refunds: { list(params: { payment_intent: string; limit: number; starting_after?: string }, options?: { timeout?: number; maxNetworkRetries?: number }): Promise<unknown> }
  disputes: { list(params: { payment_intent: string; limit: number; starting_after?: string }, options?: { timeout?: number; maxNetworkRetries?: number }): Promise<unknown> }
  balanceTransactions: { retrieve(id: string, params: {}, options?: { timeout?: number; maxNetworkRetries?: number }): Promise<unknown> }
}

export class World {
  readonly clock = virtualClock()
  readonly piId: string
  livemode: boolean
  currency: string
  amount: number
  amountReceived: number
  status: string
  chargeId: string | null
  // sticky, as Stripe's: true from the first dispute on, and it stays true after a win. `undefined` = the key is absent from the charge
  disputedFlag: boolean | null | undefined = false
  refunds: Rec[] = []
  disputes: Rec[] = []
  foreignRefunds: Rec[] = []
  foreignDisputes: Rec[] = []
  readonly transactions = new Map<string, Rec>()
  piOverride: Rec = {}
  chargeOverride: Rec = {}
  countsRequiresAction = false     // does `amount_refunded` count a refund that waits for an action? (never observed: both readings are played)
  inlineDisputeBts = true          // does a dispute carry its balance transactions as objects? (S: yes)
  ignoreExpand = false             // a payment whose `latest_charge` stays an id although `expand` asked for the object
  honorTimeout = true              // a client that honors `timeout` fails with the SDK's timeout error when the call takes longer
  guardMutations = true            // every response is a read-only view: an attempt to write is recorded in `mutationAttempts`
  latencyMs: number | ((call: CallInfo) => number)
  rules: Rule[] = []
  readonly calls: CallInfo[] = []
  readonly returned: Returned[] = []
  readonly mutationAttempts: string[] = []
  readonly history: string[] = []
  private seq = 0
  private readonly counts: Partial<Record<Method, number>> = {}
  private pending: Array<{ anchor: { method: Method; nth: number }; run: (world: World) => void; label: string; fired: boolean }> = []

  constructor(options: WorldOptions = {}) {
    this.piId = options.pi ?? 'pi_fake_1'
    this.livemode = options.livemode ?? false
    this.currency = options.currency ?? 'eur'
    this.amount = options.amount ?? 100
    this.status = options.status ?? 'succeeded'
    this.amountReceived = options.amountReceived ?? (this.status === 'succeeded' ? this.amount : 0)
    this.chargeId = options.charge === undefined ? 'ch_fake_1' : options.charge
    this.latencyMs = options.latencyMs ?? 40
  }

  // ---- building the world ----
  private born(): number { return 1_700_000_000 + ++this.seq }
  addTransaction(spec: { id: string; amount: number; fee?: number; net?: number; currency?: string; type: string; category: string; source: string; over?: Rec }): Rec {
    const fee = spec.fee ?? 0
    const bt: Rec = merge({
      id: spec.id, object: 'balance_transaction', amount: spec.amount, currency: spec.currency ?? this.currency, fee, net: spec.net ?? spec.amount - fee, type: spec.type,
      reporting_category: spec.category, source: spec.source, status: 'available', description: `CANARY description ${CANARIES.metadata}`, available_on: this.born(), exchange_rate: null,
    }, spec.over ?? {})
    this.transactions.set(spec.id, bt)
    return bt
  }
  // A refund as Stripe reports it. pending / requires_action: no balance transaction yet; succeeded: the debit (-amount); failed: the debit and the failure movement (+amount), both fee 0
  // (AR-2, scenario B); canceled: none (never observed). `debit` / `reversal` force one on or off.
  addRefund(spec: RefundSpec = {}): Rec {
    const id = spec.id ?? `re_fake_${this.refunds.length + 1}`
    const amount = spec.amount ?? 20
    const status = spec.status ?? 'succeeded'
    const currency = spec.currency ?? this.currency
    const debit = spec.debit ?? (status === 'succeeded' || status === 'failed')
    const reversal = spec.reversal ?? status === 'failed'
    if (debit) this.addTransaction({ id: `txn_${id}`, amount: -amount, fee: spec.fee ?? 0, currency, type: 'refund', category: 'refund', source: id })
    if (reversal) this.addTransaction({ id: `txn_f_${id}`, amount, fee: 0, currency, type: 'refund_failure', category: 'refund_failure', source: id })
    const refund: Rec = merge({
      id, object: 'refund', amount, currency, status, payment_intent: this.piId, charge: this.chargeId, balance_transaction: debit ? `txn_${id}` : null,
      failure_balance_transaction: reversal ? `txn_f_${id}` : null, reason: 'requested_by_customer', created: this.born(), metadata: { note: CANARIES.metadata }, receipt_number: null,
      destination_details: { card: { reference: CANARIES.fingerprint } },
    }, spec.over ?? {})
    this.refunds.push(refund)
    return refund
  }
  addForeignRefund(spec: RefundSpec & { pi?: string } = {}): Rec {
    const id = spec.id ?? `re_foreign_${this.foreignRefunds.length + 1}`
    const refund: Rec = merge({
      id, object: 'refund', amount: spec.amount ?? 7, currency: spec.currency ?? this.currency, status: spec.status ?? 'succeeded', payment_intent: spec.pi ?? 'pi_other_payment', charge: 'ch_other_payment',
      balance_transaction: null, failure_balance_transaction: null, created: this.born(),
    }, spec.over ?? {})
    this.foreignRefunds.push(refund)
    return refund
  }
  // A dispute: the disputed amount is withdrawn when it opens (SP1: -amount with a SEPARATE fee), and a won dispute reinstates it (the fee is not given back). `withdrawn: false` = no movement.
  addDispute(spec: DisputeSpec = {}): Rec {
    const id = spec.id ?? `dp_fake_${this.disputes.length + 1}`
    const amount = spec.amount ?? this.amount
    const status = spec.status ?? 'lost'
    const currency = spec.currency ?? this.currency
    const ids: string[] = []
    const withdrawn = spec.withdrawn === undefined ? amount : spec.withdrawn
    if (withdrawn !== false) {
      this.addTransaction({ id: `txn_dpw_${id}`, amount: -withdrawn, fee: spec.fee ?? 1500, currency, type: 'adjustment', category: 'dispute', source: id })
      ids.push(`txn_dpw_${id}`)
    }
    const reinstated = spec.reinstated === undefined ? (status === 'won' && withdrawn !== false ? withdrawn : false) : spec.reinstated
    if (reinstated !== false) {
      this.addTransaction({ id: `txn_dpr_${id}`, amount: reinstated, fee: 0, currency, type: 'adjustment', category: 'dispute_reversal', source: id })
      ids.push(`txn_dpr_${id}`)
    }
    const dispute: Rec = merge({
      id, object: 'dispute', amount, currency, status, payment_intent: this.piId, charge: this.chargeId, balance_transactions: ids, livemode: this.livemode, reason: 'fraudulent', created: this.born(),
      is_charge_refundable: false, metadata: { note: CANARIES.metadata },
      evidence: { customer_name: CANARIES.name, customer_email_address: CANARIES.email, uncategorized_text: CANARIES.evidence },
    }, spec.over ?? {})
    this.disputes.push(dispute)
    this.disputedFlag = true
    return dispute
  }
  addForeignDispute(spec: DisputeSpec & { pi?: string } = {}): Rec {
    const id = spec.id ?? `dp_foreign_${this.foreignDisputes.length + 1}`
    const dispute: Rec = merge({
      id, object: 'dispute', amount: spec.amount ?? 9, currency: spec.currency ?? this.currency, status: spec.status ?? 'needs_response', payment_intent: spec.pi ?? 'pi_other_payment', charge: 'ch_other_payment',
      balance_transactions: [], livemode: this.livemode, created: this.born(),
    }, spec.over ?? {})
    this.foreignDisputes.push(dispute)
    return dispute
  }
  find(kind: 'refunds' | 'disputes', id: string): Rec {
    const found = this[kind].find((entry) => entry.id === id)
    if (!found) throw new Error(`the fake world has no ${kind} ${id}`)
    return found
  }
  setRefundStatus(id: string, status: string) {
    const refund = this.find('refunds', id)
    refund.status = status
    if (status === 'succeeded' && refund.balance_transaction === null) {
      this.addTransaction({ id: `txn_${id}`, amount: -refund.amount, currency: refund.currency, type: 'refund', category: 'refund', source: id })
      refund.balance_transaction = `txn_${id}`
    }
  }
  // the refund fails: the money comes back (+amount) and `amount_refunded` goes down
  failRefund(id: string) {
    const refund = this.find('refunds', id)
    refund.status = 'failed'
    if (refund.balance_transaction === null) {
      this.addTransaction({ id: `txn_${id}`, amount: -refund.amount, currency: refund.currency, type: 'refund', category: 'refund', source: id })
      refund.balance_transaction = `txn_${id}`
    }
    this.addTransaction({ id: `txn_f_${id}`, amount: refund.amount, currency: refund.currency, type: 'refund_failure', category: 'refund_failure', source: id })
    refund.failure_balance_transaction = `txn_f_${id}`
  }
  setDisputeStatus(id: string, status: string) { this.find('disputes', id).status = status }
  winDispute(id: string, reinstated?: number) {
    const dispute = this.find('disputes', id)
    dispute.status = 'won'
    const amount = reinstated ?? dispute.amount
    this.addTransaction({ id: `txn_dpr_${id}`, amount, fee: 0, currency: dispute.currency, type: 'adjustment', category: 'dispute_reversal', source: id })
    dispute.balance_transactions = [...dispute.balance_transactions, `txn_dpr_${id}`]
  }

  // ---- what the world says (always recomputed from its state: the aggregates follow the refunds) ----
  refundedAggregate(): number {
    return this.refunds.reduce((sum, refund) => sum + (refund.status === 'succeeded' || refund.status === 'pending' || (this.countsRequiresAction && refund.status === 'requires_action') ? refund.amount : 0), 0)
  }
  chargeObject(): Rec | null {
    if (this.chargeId === null) return null
    const base: Rec = {
      id: this.chargeId, object: 'charge', amount: this.amount, amount_captured: this.amountReceived, amount_refunded: this.refundedAggregate(), currency: this.currency, disputed: this.disputedFlag,
      payment_intent: this.piId, livemode: this.livemode, paid: true, status: 'succeeded', refunded: this.refundedAggregate() === this.amount, transfer_data: null, on_behalf_of: null,
      application_fee_amount: null, balance_transaction: 'txn_charge_fake', receipt_url: CANARIES.receipt, receipt_email: CANARIES.email, metadata: { note: CANARIES.metadata },
      billing_details: { name: CANARIES.name, email: CANARIES.email, phone: CANARIES.phone, address: { line1: CANARIES.street, city: 'CANARY CITY', country: 'IT' } },
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', fingerprint: CANARIES.fingerprint } },
    }
    return merge(base, this.chargeOverride)
  }
  piObject(expandCharge: boolean): Rec {
    const base: Rec = {
      id: this.piId, object: 'payment_intent', amount: this.amount, amount_capturable: 0, amount_received: this.amountReceived, currency: this.currency, status: this.status, livemode: this.livemode,
      latest_charge: this.chargeId === null ? null : expandCharge && !this.ignoreExpand ? this.chargeObject() : this.chargeId,
      transfer_data: null, on_behalf_of: null, application_fee_amount: null,
      client_secret: `${this.piId}_secret_${CANARIES.clientSecret}`, customer: 'cus_CANARY', receipt_email: CANARIES.email, metadata: { note: CANARIES.metadata },
      shipping: { name: CANARIES.name, address: { line1: CANARIES.street } }, description: `CANARY description ${CANARIES.metadata}`,
    }
    return merge(base, this.piOverride)
  }
  disputeObject(dispute: Rec): Rec {
    const out: Rec = { ...dispute }
    if (Array.isArray(dispute.balance_transactions) && this.inlineDisputeBts) {
      out.balance_transactions = dispute.balance_transactions.map((entry: unknown) => (typeof entry === 'string' && this.transactions.has(entry) ? clone(this.transactions.get(entry)) : entry))
    }
    return out
  }
  private bt(id: unknown): unknown { return typeof id === 'string' && this.transactions.has(id) ? clone(this.transactions.get(id)) : id }

  // ---- the full atomic reading of the CURRENT state, straight from the state (it does not use the reader and does not log a call): the oracle of the differential tests ----
  oracleRaw(): Rec {
    return {
      paymentIntent: this.piObject(true),
      charge: this.chargeObject(),
      refunds: { data: this.listItems('refunds', { payment_intent: this.piId }).map((refund) => ({ ...refund, balance_transaction: this.bt(refund.balance_transaction), failure_balance_transaction: this.bt(refund.failure_balance_transaction) })), has_more: false },
      disputes: { data: this.listItems('disputes', { payment_intent: this.piId }).map((dispute) => this.disputeObject(dispute)), has_more: false },
    }
  }

  // ---- lists: newest first, a cursor is a position ----
  private listItems(kind: 'refunds' | 'disputes', filters: Rec): Rec[] {
    const own = this[kind].map((entry) => ({ entry, own: true }))
    const foreign = (kind === 'refunds' ? this.foreignRefunds : this.foreignDisputes).map((entry) => ({ entry, own: false }))
    const wantPi = filters.payment_intent
    const wantCharge = filters.charge
    return [...own, ...foreign]
      .filter(({ entry, own: isOwn }) => (wantPi === undefined || (isOwn ? wantPi === this.piId : entry.payment_intent === wantPi)) && (wantCharge === undefined || (isOwn ? wantCharge === this.chargeId : entry.charge === wantCharge)))
      .map(({ entry }) => entry)
      .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  }

  // ---- the answers (no logging, no clock: used by the client and by the wire transport) ----
  respond(method: Method, id: string | undefined, params: any): Outcome {
    if (method === 'paymentIntents.retrieve') {
      if (typeof id !== 'string' || id !== this.piId) return rejectWith(sdkErrors.notFound('payment_intent', String(id)))
      const keys = params === undefined ? [] : params !== null && typeof params === 'object' ? Object.keys(params) : null
      if (keys === null || keys.some((key) => key !== 'expand')) return rejectWith(sdkErrors.invalidRequest('Received unknown parameter'))
      const expand = params?.expand
      if (expand !== undefined && (!Array.isArray(expand) || expand.some((entry: unknown) => typeof entry !== 'string'))) return rejectWith(sdkErrors.invalidRequest('Invalid array'))
      return ok(this.piObject(Array.isArray(expand) && expand.includes('latest_charge')))
    }
    if (method === 'balanceTransactions.retrieve') {
      if (typeof id !== 'string' || !this.transactions.has(id)) return rejectWith(sdkErrors.notFound('balance_transaction', String(id)))
      if (params !== undefined && (params === null || typeof params !== 'object' || Object.keys(params).length > 0)) return rejectWith(sdkErrors.invalidRequest('Received unknown parameter'))
      return ok(clone(this.transactions.get(id)))
    }
    const kind = method === 'refunds.list' ? 'refunds' : 'disputes'
    let p: Rec = params ?? {}
    // the SDK's trap: an object that holds a REQUEST OPTION is taken as the options and its other keys (the filters, the limit) are ignored - the request goes out unfiltered
    if (p !== null && typeof p === 'object' && Object.keys(p).some((key) => OPTION_KEYS.includes(key))) p = {}
    if (p === null || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some((key) => !LIST_KEYS.includes(key))) return rejectWith(sdkErrors.invalidRequest('Received unknown parameter'))
    const limit = p.limit === undefined ? 10 : p.limit
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return rejectWith(sdkErrors.invalidRequest('Invalid limit'))
    if (p.starting_after !== undefined && typeof p.starting_after !== 'string') return rejectWith(sdkErrors.invalidRequest('Invalid starting_after'))
    const items = this.listItems(kind, p)
    let start = 0
    if (p.starting_after !== undefined) {
      const at = items.findIndex((entry) => entry.id === p.starting_after)
      if (at < 0) return rejectWith(sdkErrors.notFound(kind === 'refunds' ? 'refund' : 'dispute', p.starting_after))
      start = at + 1
    }
    const page = items.slice(start, start + limit)
    return ok({ object: 'list', url: `/v1/${kind}`, has_more: start + limit < items.length, data: page.map((entry) => (kind === 'refunds' ? { ...entry } : this.disputeObject(entry))) })
  }

  // ---- the client ----
  client(): FakeClient {
    const world = this
    const make = <T extends object>(methods: (self: T) => T): T => {
      const namespace: T = {} as T
      Object.assign(namespace, methods(namespace))
      return namespace
    }
    // each method checks its receiver: a method called DETACHED (without its namespace) fails, as the SDK's own methods do
    const bound = (namespace: object, name: string, run: (...args: any[]) => Promise<unknown>) =>
      function (this: unknown, ...args: any[]) {
        if (this !== namespace) throw new TypeError(`${name} was called without its receiver`)
        return run(...args)
      }
    return {
      paymentIntents: make<any>((self) => ({ retrieve: bound(self, 'paymentIntents.retrieve', (id: string, params: any, options: any) => world.handle('paymentIntents.retrieve', id, params, options)) })),
      refunds: make<any>((self) => ({ list: bound(self, 'refunds.list', (params: any, options: any) => world.handle('refunds.list', undefined, params, options)) })),
      disputes: make<any>((self) => ({ list: bound(self, 'disputes.list', (params: any, options: any) => world.handle('disputes.list', undefined, params, options)) })),
      balanceTransactions: make<any>((self) => ({ retrieve: bound(self, 'balanceTransactions.retrieve', (id: string, params: any, options: any) => world.handle('balanceTransactions.retrieve', id, params, options)) })),
    }
  }
  // A client that records every property the caller touches and refuses anything but the four methods (a write method, a stray property, a symbol-less probe of the SDK surface)
  trapClient(): { client: FakeClient; touched: string[] } {
    const inner = this.client() as any
    const touched: string[] = []
    const ALLOWED: Record<string, string> = { paymentIntents: 'retrieve', refunds: 'list', disputes: 'list', balanceTransactions: 'retrieve' }
    const client = new Proxy(inner, {
      get(target, property) {
        if (typeof property === 'symbol') return undefined
        touched.push(property)
        if (!(property in ALLOWED)) throw new Error(`forbidden access on the client: ${property}`)
        const namespace = target[property]
        return new Proxy(namespace, {
          get(inside, method) {
            if (typeof method === 'symbol') return undefined
            touched.push(`${property}.${method}`)
            if (method !== ALLOWED[property]) throw new Error(`forbidden access on the client: ${property}.${method}`)
            return inside[method].bind(inside)
          },
        })
      },
    })
    return { client, touched }
  }

  // ---- rules, events, calls ----
  addRule(rule: Rule): Rule {
    this.rules.push(rule)
    return rule
  }
  // a fault at the nth call of a method (nth omitted = every call of it)
  fault(method: Method, nth: number | undefined, act: (call: CallInfo, normal: () => Outcome) => Outcome, label = 'fault'): Rule {
    return this.addRule({ match: (call) => call.method === method && (nth === undefined || call.nth === nth), act, label })
  }
  // an event of the world that fires BEFORE the nth call of a method (T0..T3 name the usual places)
  at(anchor: Anchor, run: (world: World) => void, label = 'event') {
    this.pending.push({ anchor: typeof anchor === 'string' ? ANCHORS[anchor] : anchor, run, label, fired: false })
  }
  apply(run: (world: World) => void, label = 'applied') {
    this.history.push(`${label} @call ${this.calls.length}`)
    run(this)
  }
  unfired(): string[] { return this.pending.filter((entry) => !entry.fired).map((entry) => entry.label) }
  callsOf(method: Method): CallInfo[] { return this.calls.filter((call) => call.method === method) }

  handle(method: Method, id: string | undefined, params: any, options: any): Promise<unknown> {
    const nth = (this.counts[method] = (this.counts[method] ?? 0) + 1)
    const info: CallInfo = { n: this.calls.length + 1, nth, method, id, params: clone(params), options: clone(options), atMs: this.clock.now() }
    this.calls.push(info)
    for (const entry of this.pending) {
      if (!entry.fired && entry.anchor.method === method && entry.anchor.nth === nth) {
        entry.fired = true
        this.history.push(`${entry.label} @call ${info.n} (before ${method} #${nth})`)
        entry.run(this)
      }
    }
    const latency = typeof this.latencyMs === 'function' ? this.latencyMs(info) : this.latencyMs
    const timeout = options && typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : 80_000   // the SDK's own default when none is given
    let outcome: Outcome
    const normal = () => this.respond(method, id, params)
    const rule = this.rules.find((candidate) => candidate.match(info))
    if (this.honorTimeout && latency > timeout) {
      this.clock.advance(timeout)
      outcome = rejectWith(sdkErrors.timeout(timeout))
    } else {
      this.clock.advance(latency)
      outcome = rule ? rule.act(info, normal) : normal()
    }
    if (outcome.type === 'throw') {
      this.returned.push({ n: info.n, nth, method, id, error: 'thrown synchronously' })
      throw outcome.error
    }
    if (outcome.type === 'reject') {
      let described = 'rejected'
      try { described = String((outcome.error as any)?.type ?? typeof outcome.error) } catch { described = 'hostile error' }
      this.returned.push({ n: info.n, nth, method, id, error: described })
      return Promise.reject(outcome.error)
    }
    if (outcome.type === 'never') {
      this.returned.push({ n: info.n, nth, method, id, never: true })
      return new Promise(() => undefined)
    }
    this.returned.push({ n: info.n, nth, method, id, response: clone(outcome.value) })
    return Promise.resolve(this.guardMutations ? readOnlyView(outcome.value, (what) => this.mutationAttempts.push(`${method} #${nth}: ${what}`)) : outcome.value)
  }
}

// ---- common faults ---------------------------------------------------------------------------------------------------------------------------------------------------------
export const fail = {
  sdk: (build: () => Error) => (): Outcome => rejectWith(build()),
  reject: (value: unknown) => (): Outcome => rejectWith(value),
  throwSync: (value: unknown) => (): Outcome => throwSync(value),
  resolve: (value: unknown) => (): Outcome => ok(value),
  never: () => (): Outcome => never(),
  // the normal answer, changed by `change` (on a copy)
  transform: (change: (response: any) => any) => (_call: CallInfo, normal: () => Outcome): Outcome => {
    const out = normal()
    if (out.type !== 'value') return out
    return ok(change(clone(out.value)))
  },
}

// ---- events: the nine of the plan (X1-X9) and the six bases they happen to (B-a ... B-f) -------------------------------------------------------------------------------
export const EVENT_IDS = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8', 'X9'] as const
export type EventId = (typeof EVENT_IDS)[number]
export const BASE_IDS = ['B-a', 'B-b', 'B-c', 'B-d', 'B-e', 'B-f'] as const
export type BaseId = (typeof BASE_IDS)[number]
export const EVENT_TEXT: Record<EventId, string> = {
  X1: 'a new refund, pending', X2: 'a pending refund succeeds', X3: 'a succeeded refund fails', X4: 'a refund fails and a new refund of the same amount is made (ABA)',
  X5: 'the first dispute opens (the flag turns true)', X6: 'an open dispute is lost', X7: 'an open dispute is won with a reinstatement', X8: 'a second dispute opens (the flag is already true)',
  X9: 'a refund that waits for an action (the aggregate does not count it)',
}
export const BASE_TEXT: Record<BaseId, string> = {
  'B-a': 'paid, nothing else', 'B-b': 'a refund of 20 that succeeded', 'B-c': 'a total refund that succeeded', 'B-d': 'a refund of 20, pending', 'B-e': 'a dispute, open', 'B-f': 'a dispute, won, funds reinstated',
}
// the pairs (event, base) that can happen: a refund cannot be started on a payment that was refunded in full, an open dispute is not "first" twice, and so on
export const PAIRS: ReadonlyArray<readonly [EventId, BaseId]> = [
  ['X1', 'B-a'], ['X1', 'B-b'], ['X1', 'B-d'], ['X1', 'B-f'],
  ['X2', 'B-d'],
  ['X3', 'B-b'], ['X3', 'B-c'],
  ['X4', 'B-b'], ['X4', 'B-c'],
  ['X5', 'B-a'], ['X5', 'B-b'], ['X5', 'B-c'], ['X5', 'B-d'],
  ['X6', 'B-e'], ['X7', 'B-e'],
  ['X8', 'B-e'], ['X8', 'B-f'],
  ['X9', 'B-a'], ['X9', 'B-b'], ['X9', 'B-d'], ['X9', 'B-f'],
]
export function applyBase(world: World, base: BaseId) {
  if (base === 'B-b') world.addRefund({ id: 're_a', amount: 20, status: 'succeeded' })
  else if (base === 'B-c') world.addRefund({ id: 're_a', amount: world.amount, status: 'succeeded' })
  else if (base === 'B-d') world.addRefund({ id: 're_a', amount: 20, status: 'pending' })
  else if (base === 'B-e') world.addDispute({ id: 'dp_1', amount: world.amount, status: 'needs_response' })
  else if (base === 'B-f') world.addDispute({ id: 'dp_1', amount: world.amount, status: 'won' })
}
export function applyEvent(world: World, event: EventId) {
  if (event === 'X1') world.addRefund({ id: 're_new', amount: 20, status: 'pending' })
  else if (event === 'X2') world.setRefundStatus('re_a', 'succeeded')
  else if (event === 'X3') world.failRefund('re_a')
  else if (event === 'X4') {
    const amount = world.find('refunds', 're_a').amount
    world.failRefund('re_a')
    world.addRefund({ id: 're_b', amount, status: 'pending' })
  } else if (event === 'X5') world.addDispute({ id: 'dp_new', amount: world.amount, status: 'needs_response' })
  else if (event === 'X6') world.setDisputeStatus('dp_1', 'lost')
  else if (event === 'X7') world.winDispute('dp_1')
  else if (event === 'X8') world.addDispute({ id: 'dp_2', amount: Math.floor(world.amount / 2), status: 'needs_response' })
  else if (event === 'X9') world.addRefund({ id: 're_ra', amount: 20, status: 'requires_action' })
}
export function caseWorld(event: EventId, base: BaseId, time: 'T0' | 'T1' | 'T2' | 'T3' | 'T4', variant: { countsRequiresAction?: boolean } = {}): World {
  const world = new World({ pi: 'pi_case', charge: 'ch_case' })
  world.countsRequiresAction = variant.countsRequiresAction ?? false
  applyBase(world, base)
  if (time !== 'T4') world.at(time, (w) => applyEvent(w, event), `${event} at ${time}`)
  return world
}

// ---- a random world (coherent) and random events ----------------------------------------------------------------------------------------------------------------------------
// Values that are NOT what Stripe sends in a field the funds model reads: text where a number belongs, fractions, upper case, null, infinities, a fraction of a cent. A reader must carry them as they are.
export const DIRTY_VALUES: readonly unknown[] = ['20', 'EUR', ' succeeded ', -5, 1.5, null, true, '', 'x y', 0, 1e21, Number.NaN, Number.POSITIVE_INFINITY, -0, 'Lost', 9007199254740993]
// puts ONE dirty value (or removes the field) in ONE field the model reads - never in an id, a type, a mode or a reference, which the reader checks and would refuse
export function makeDirty(world: World, random: Random): string {
  const setters: Array<[string, (value: unknown) => void]> = []
  for (const name of ['amount_received', 'currency', 'status']) setters.push([`payment.${name}`, (value) => { world.piOverride = { ...world.piOverride, [name]: value } }])
  if (world.chargeId !== null) for (const name of ['amount_captured', 'amount_refunded', 'currency', 'disputed']) setters.push([`charge.${name}`, (value) => { world.chargeOverride = { ...world.chargeOverride, [name]: value } }])
  const onRecord = (label: string, record: Rec, names: string[]) => { for (const name of names) setters.push([`${label}.${name}`, (value) => { if (value === undefined) delete record[name]; else record[name] = value }]) }
  for (const refund of world.refunds) onRecord(`refund ${refund.id}`, refund, ['amount', 'currency', 'status'])
  for (const dispute of world.disputes) onRecord(`dispute ${dispute.id}`, dispute, ['amount', 'currency', 'status'])
  for (const [id, movement] of world.transactions) onRecord(`movement ${id}`, movement, ['amount', 'fee', 'net', 'currency', 'reporting_category'])
  const [label, set] = pick(random, setters)
  const value = random() < 0.2 ? undefined : pick(random, DIRTY_VALUES)
  set(value)
  return `${label} = ${String(value)}`
}
export function randomWorld(seed: number, options: { dirty?: boolean } = {}): World {
  const random = mulberry32(seed)
  const status = random() < 0.82 ? 'succeeded' : pick(random, ['canceled', 'processing', 'requires_payment_method', 'requires_capture'])
  const amount = pick(random, [100, 250, 999, 1234, 5000, 10000])
  const partial = status === 'succeeded' && random() < 0.15
  const withoutCharge = (status === 'canceled' || status === 'requires_payment_method') && random() < 0.8
  const world = new World({
    pi: `pi_r${seed}`, charge: withoutCharge ? null : `ch_r${seed}`, status, amount, amountReceived: status === 'succeeded' ? (partial ? Math.floor(amount * 0.6) : amount) : 0,
    currency: pick(random, ['eur', 'eur', 'eur', 'usd', 'gbp']), livemode: random() < 0.3,
  })
  const collected = world.amountReceived
  if (world.chargeId !== null && collected > 3) {
    const refunds = between(random, 0, 5)
    let left = collected
    for (let index = 0; index < refunds && left > 2; index++) {
      const amountOf = between(random, 1, Math.max(1, Math.floor(left / 2)))
      const statusOf = pick(random, ['succeeded', 'succeeded', 'succeeded', 'pending', 'failed', 'failed', 'requires_action', 'canceled'])
      world.addRefund({ id: `re_r${seed}_${index}`, amount: amountOf, status: statusOf })
      if (statusOf !== 'failed' && statusOf !== 'canceled') left -= amountOf
    }
    const disputes = between(random, 0, 2)
    for (let index = 0; index < disputes; index++) {
      const amountOf = between(random, 1, collected)
      world.addDispute({ id: `dp_r${seed}_${index}`, amount: amountOf, status: pick(random, ['needs_response', 'under_review', 'lost', 'lost', 'won', 'won', 'warning_needs_response', 'warning_closed']) })
    }
  }
  const foreign = between(random, 0, 2)
  for (let index = 0; index < foreign; index++) {
    world.addForeignRefund({ id: `re_f${seed}_${index}` })
    if (random() < 0.5) world.addForeignDispute({ id: `dp_f${seed}_${index}` })
  }
  // done last, so that the world above is the same with or without it: about one world in eight carries one dirty value
  if ((options.dirty ?? true) && random() < 0.125) makeDirty(world, random)
  return world
}
// a handful of random events at random places: the world changes while it is being read
export function scheduleRandomEvents(world: World, seed: number, max = 3): string[] {
  const random = mulberry32(seed ^ 0x9e3779b9)
  const labels: string[] = []
  const count = between(random, 0, max)
  for (let index = 0; index < count; index++) {
    const anchor = pick(random, ['T0', 'T1', 'T2', 'T3'] as const)
    const kind = pick(random, ['refund_new', 'refund_new', 'refund_succeed', 'refund_fail', 'dispute_new', 'dispute_status', 'requires_action', 'drift'] as const)
    const label = `${kind}@${anchor}#${index}`
    labels.push(label)
    world.at(anchor, (w) => {
      if (kind === 'refund_new') w.addRefund({ id: `re_e${seed}_${index}`, amount: between(random, 1, 9), status: 'pending' })
      else if (kind === 'requires_action') w.addRefund({ id: `re_e${seed}_${index}`, amount: between(random, 1, 9), status: 'requires_action' })
      else if (kind === 'refund_succeed') { const target = w.refunds.find((refund) => refund.status === 'pending'); if (target) w.setRefundStatus(target.id, 'succeeded') }
      else if (kind === 'refund_fail') { const target = w.refunds.find((refund) => refund.status === 'succeeded' || refund.status === 'pending'); if (target) w.failRefund(target.id) }
      else if (kind === 'dispute_new') w.addDispute({ id: `dp_e${seed}_${index}`, amount: between(random, 1, Math.max(1, w.amountReceived)), status: 'needs_response' })
      else if (kind === 'dispute_status') { const target = w.disputes.find((dispute) => dispute.status !== 'won'); if (target) w.setDisputeStatus(target.id, pick(random, ['lost', 'under_review'])) }
      else w.chargeOverride = { ...w.chargeOverride, amount_refunded: between(random, 0, Math.max(1, w.amountReceived)) }   // an aggregate that drifts from the list
    }, label)
  }
  return labels
}

// ---- the projection a test expects (an INDEPENDENT list of the fields the funds model reads, written here and not taken from the reader) ---------------------------------------------
export const EXPECTED_FIELDS = {
  paymentIntent: ['id', 'amount_received', 'currency', 'status', 'latest_charge'],
  charge: ['id', 'amount_captured', 'amount_refunded', 'currency', 'disputed', 'payment_intent'],
  refund: ['id', 'amount', 'currency', 'status', 'payment_intent', 'charge', 'balance_transaction', 'failure_balance_transaction'],
  dispute: ['id', 'amount', 'currency', 'status', 'payment_intent', 'charge', 'balance_transactions'],
  transaction: ['id', 'amount', 'currency', 'fee', 'net', 'reporting_category', 'source'],
} as const
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const refOf = (value: unknown): unknown => (isRec(value) ? ('id' in value && value.id !== undefined ? { id: value.id } : {}) : value)
export function expectedTransaction(raw: unknown): unknown {
  if (!isRec(raw)) return raw
  const out: Rec = {}
  for (const key of EXPECTED_FIELDS.transaction) if (key in raw && raw[key] !== undefined) out[key] = key === 'source' ? refOf(raw[key]) : raw[key]
  return out
}
const movement = (value: unknown): unknown => (typeof value === 'string' || value === null || !isRec(value) ? value : expectedTransaction(value))
export function expectedProjection(kind: 'paymentIntent' | 'charge' | 'refund' | 'dispute', raw: Rec, movements?: (id: string) => unknown): Rec {
  const out: Rec = {}
  const refKeys = ['latest_charge', 'payment_intent', 'charge']
  for (const key of EXPECTED_FIELDS[kind] as readonly string[]) {
    if (!(key in raw) || raw[key] === undefined) continue
    const value = raw[key]
    if (refKeys.includes(key)) out[key] = refOf(value)
    else if (kind === 'refund' && (key === 'balance_transaction' || key === 'failure_balance_transaction')) {
      const resolved = typeof value === 'string' && movements ? movements(value) : undefined
      out[key] = resolved !== undefined ? expectedTransaction(resolved) : movement(value)
    }
    else if (kind === 'dispute' && key === 'balance_transactions') out[key] = Array.isArray(value) ? value.map(movement) : value
    else out[key] = value
  }
  return out
}

// ---- the wire: the REAL SDK over a fake `httpClient` that answers from the world -------------------------------------------------------------------------------------------------------
export type WireRequest = { n: number; host: string; port: string; path: string; method: string; headers: Record<string, string>; requestData: unknown; protocol: string; timeout: number }
export type WireFault = { status: number; body?: unknown; raw?: string } | { network: Error }
export function wire(world: World, faults: Record<number, WireFault> = {}, sdkOptions: Rec = {}) {
  const requests: WireRequest[] = []
  class FakeResponse {
    constructor(private readonly status: number, private readonly body: string) {}
    getStatusCode() { return this.status }
    getHeaders() { return { 'content-type': 'application/json', 'request-id': 'req_fake' } as any }
    getRawResponse() { return {} as any }
    toStream(done: () => void) { done(); return {} as any }
    toJSON() { return Promise.resolve(JSON.parse(this.body)) }
  }
  const json = (status: number, body: unknown) => new FakeResponse(status, JSON.stringify(body))
  const serve = (path: string): FakeResponse => {
    const url = new URL(`https://fake.invalid${path}`)
    const params: Rec = {}
    for (const [key, value] of url.searchParams) {
      const expand = key.match(/^expand\[(\d+)\]$/)
      if (expand) (params.expand ??= [])[Number(expand[1])] = value
      else params[key] = key === 'limit' ? Number(value) : value
    }
    const segments = url.pathname.split('/').filter(Boolean)   // v1, payment_intents, pi_x
    let outcome: Outcome
    if (segments[1] === 'payment_intents' && segments.length === 3) outcome = world.respond('paymentIntents.retrieve', segments[2], params)
    else if (segments[1] === 'balance_transactions' && segments.length === 3) outcome = world.respond('balanceTransactions.retrieve', segments[2], params)
    else if (segments[1] === 'refunds' && segments.length === 2) outcome = world.respond('refunds.list', undefined, params)
    else if (segments[1] === 'disputes' && segments.length === 2) outcome = world.respond('disputes.list', undefined, params)
    else return json(404, { error: { type: 'invalid_request_error', message: 'Unrecognized request URL' } })
    if (outcome.type === 'value') return json(200, outcome.value)
    const error: any = (outcome as any).error
    return json(error?.statusCode ?? 400, { error: { type: error?.rawType ?? 'invalid_request_error', code: error?.code, message: String(error?.message ?? 'error') } })
  }
  class FakeHttp extends (Stripe as any).HttpClient {
    getClientName() { return 'fake-wire' }
    makeRequest(host: string, port: string, path: string, method: string, headers: Record<string, string>, requestData: unknown, protocol: string, timeout: number) {
      const n = requests.length + 1
      requests.push({ n, host, port, path, method, headers: { ...headers }, requestData, protocol, timeout })
      const fault = faults[n]
      if (fault && 'network' in fault) return Promise.reject(fault.network)
      if (fault) return Promise.resolve(new FakeResponse(fault.status, fault.raw ?? JSON.stringify(fault.body ?? { error: { type: 'api_error', message: 'x' } })))
      return Promise.resolve(serve(path))
    }
  }
  const stripe = new Stripe(FAKE_KEY, { httpClient: new FakeHttp() as any, ...sdkOptions })
  return { stripe, requests }
}
