// The READER of the Stripe evidence of the funds of ONE payment (step 4.6, S6, P3a.1) - read only, injected, connected to nothing.
//
// WHAT IT DOES: it asks Stripe, through a client that is handed to it, for what the funds model (P1, `computeFundsPosition`) reads about one payment - the payment, its charge, ALL its refunds, ALL its
// disputes, and the balance transactions of its refunds - and it hands that over as evidence, in the shape the model takes, together with a report of HOW the reading went.
// WHAT IT DOES NOT DO: it decides nothing, adds nothing up, converts nothing, repairs nothing and drops nothing. The position of the money is the model's. It holds no threshold, no policy and no
// state between two readings. It imports nothing (not even a type), reads no clock but the one it is given, writes nothing, and nothing of the application calls it yet.
//
// A READING IS NOT A SNAPSHOT. It is a composition of observations made one after the other, and Stripe offers no atomic read of those objects. Two identical reads of the payment (the first and the
// closing one) prove that THE FIELDS THE MODEL READS of the payment and of its charge were the same at those two moments, and nothing else: not that a refund did not fail and was made again, not that
// a dispute did not change while the charge's flag stayed put, not that an entry was not born after its list was read, and nothing at all about what happens after the last read. What nobody
// verifies is a fixed, frozen list in every report (`FUNDS_READ_NOT_VERIFIED`).
//
// THREE THINGS KEPT APART IN THE REPORT
//   * STRUCTURE (`structure`): was everything that must be read read to its end, with its identity, its type and its MODE checked? A list is complete only if it was walked until `has_more` was false.
//     A balance transaction that stayed an id is NOT a movement that was seen (an id hides contradictions): the reading is incomplete. A charge that was not expanded, or is not this payment's, is
//     withheld. The mode (`livemode`) the caller expects is checked on the payment, the charge and the disputes (refunds and balance transactions do not declare one in the SDK's types).
//   * TIME (`temporal`): which signs of change were looked for and what they showed - the closing read of the payment, a walk that met the same entry twice. `no_change_observed` means "no sign was seen",
//     not "nothing changed".
//   * FINALITY: not here. Whether a position can still change is not a property of a reading (the model's `final` is narrow, and does not mean "stable in time").
// Both lists of the evidence are handed over with `has_more: true` unless the structure is complete AND no change was observed: so the model answers "uncertain" even for a caller who reads nothing of the
// report. A list that could not be read at all is `null`, never an empty list.
//
// TIME AND TERMINATION. What is bounded: the number of calls (at most 2 + 2 x pages + movement reads, 32 with the defaults), the `timeout` handed to the SDK with EVERY call (an explicit integer, never
// omitted, never zero, never more than half of what is left of the deadline once a margin is taken away), and the start of any call after the deadline (none is started when the injected clock says there
// is no room). What is NOT bounded: the real time a call takes if the client ignores its timeout, and a promise that never settles - there is no timer and no race here, so such a reading waits as long as
// the client does, and the absolute ceiling belongs to the caller. The real SDK must be given its timeouts (this reader always does) and must not retry on its own (`maxNetworkRetries` is always 0).
//
// INVALID INPUT is refused before any call, reported by NAME (never by value) and never repaired. Whatever the answers of Stripe hold is copied as it came: a string where a number belongs stays a
// string, an upper-case currency stays upper case, an absent field stays absent. A value that is not a scalar where a scalar belongs is replaced by a marker no id, currency or number can equal, so that
// nothing of it travels along and the model refuses it.
//
// THE REFUNDS THE APPLICATION ASKED FOR (`requestedRefunds`) are the caller's words, not Stripe's, and the caller keeps its own objects: they are COPIED - once, in the part that runs before the first await - into a
// new array of new objects that carry `id`, `amount` and `currency` and nothing else, with the values as they were given (an absent property stays absent, null stays null; nothing is rounded, converted,
// de-duplicated or dropped). Their TYPE and STRUCTURE are checked there: an array of at most a thousand objects whose three properties, when present, are a string or null, a number or null, a string or null. Whether an amount
// is a positive whole number of cents, whether an id is well formed, what to make of duplicates and of conflicts: that is the funds model's, not the reader's. What fails the check is refused AS A WHOLE, by name,
// before any call, and nothing of it is handed back. A JSON image of the evidence is not a lossless copy of it (JSON writes NaN and the infinities as null and -0 as 0): the evidence is the object, never its JSON.

// ---- the client: four calls that read. The real `Stripe` client is assignable to this interface (proved by the tests, by compilation); it has no way to write ---------------------------------------
export type ReadRequestOptions = { timeout?: number; maxNetworkRetries?: number }
export interface StripeFundsClient {
  paymentIntents: { retrieve(id: string, params: { expand: string[] }, options?: ReadRequestOptions): Promise<unknown> }
  refunds: { list(params: { payment_intent: string; limit: number; starting_after?: string }, options?: ReadRequestOptions): Promise<unknown> }
  disputes: { list(params: { payment_intent: string; limit: number; starting_after?: string }, options?: ReadRequestOptions): Promise<unknown> }
  balanceTransactions: { retrieve(id: string, params: {}, options?: ReadRequestOptions): Promise<unknown> }
}

// ---- what is asked ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A refund the application asked for: the caller's words, not Stripe's. The reader COPIES it - these three properties and no others, with the values as given - and hands the model its copy: never the caller's own
// object, and never de-duplicated or corrected here.
export type RequestedRefundInput = { id?: string | null; amount?: number | null; currency?: string | null }
export type FundsReadRequest = {
  paymentIntentId: string
  // the mode the caller expects (true = live), from its own configuration. Mandatory: the reader knows no key and no environment
  expectedLivemode: boolean
  // at most a thousand (a technical limit of the reader, not a parameter); copied, once, before the first await; absent = none given
  requestedRefunds?: ReadonlyArray<RequestedRefundInput>
}
export type FundsReadOptions = {
  now: () => number                  // milliseconds, injected: the reader has no clock of its own (a clock that goes back is held at its highest reading)
  perCallTimeoutMs?: number          // 5000      (500..60000, an integer)
  deadlineMs?: number                // 15000     (1000..120000) for the whole reading
  pageSize?: number                  // 100       (1..100)
  maxPages?: number                  // 5         (1..50) for each list
  maxMovementReads?: number          // 20        (0..100) balance transactions read by id
}                                    // a value that is present and out of its range is INVALID INPUT (nothing is read); an absent one takes its default

export const FUNDS_READ_DEFAULTS = Object.freeze({ perCallTimeoutMs: 5000, deadlineMs: 15000, pageSize: 100, maxPages: 5, maxMovementReads: 20 })

// ---- what is handed back: evidence in the shape of the model's input (the funds model is not named here) ------------------------------------------------------------------------------------------
type Reference = string | { id?: string | null } | null
export type BalanceTransactionOut = { id?: string | null; amount?: number | null; currency?: string | null; fee?: number | null; net?: number | null; reporting_category?: string | null; source?: Reference }
export type PaymentIntentOut = { id?: string | null; amount_received?: number | null; currency?: string | null; status?: string | null; latest_charge?: Reference }
export type ChargeOut = { id?: string | null; amount_captured?: number | null; amount_refunded?: number | null; currency?: string | null; disputed?: boolean | null; payment_intent?: Reference }
export type RefundOut = {
  id?: string | null; amount?: number | null; currency?: string | null; status?: string | null; payment_intent?: Reference; charge?: Reference
  balance_transaction?: string | BalanceTransactionOut | null; failure_balance_transaction?: string | BalanceTransactionOut | null
}
export type DisputeOut = {
  id?: string | null; amount?: number | null; currency?: string | null; status?: string | null; payment_intent?: Reference; charge?: Reference
  balance_transactions?: ReadonlyArray<string | BalanceTransactionOut> | null
}
export type ListOut<T> = { data: T[]; has_more: boolean }
export type FundsEvidenceOut = {
  paymentIntent: PaymentIntentOut | null
  charge: ChargeOut | null
  refunds: ListOut<RefundOut> | null     // null = NOT READ (never an empty list)
  disputes: ListOut<DisputeOut> | null
  requestedRefunds?: RequestedRefundInput[]   // OPTIONAL, and really absent (no key) when the caller gave none or the reading was refused; otherwise a COPY of the caller's list, never the list itself
}

// ---- the report ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type ReadCall = 'input' | 'reader' | 'paymentIntents.retrieve' | 'refunds.list' | 'disputes.list' | 'balanceTransactions.retrieve'
export type ReadFailureKind =
  | 'invalid_input' | 'timeout' | 'connection' | 'rate_limit' | 'authentication' | 'permission' | 'invalid_request' | 'api' | 'unknown' | 'malformed_response' | 'identity_mismatch'
  | 'mode_unverified' | 'mode_mismatch' | 'budget' | 'internal_error'
// never the text of an error. `ref` is the NAME of an input, `latest_charge`, `cursor`, a budget (calls, deadline, clock, pages, movements) or the id of a balance transaction
export type ReadFailure = { call: ReadCall; kind: ReadFailureKind; page?: number; statusCode?: number; code?: string; ref?: string }
// the only causes for which the STRUCTURE of a reading is incomplete (a frozen list, for tests and readers)
export const FUNDS_READ_STRUCTURE_REASONS = Object.freeze([
  'invalid_input', 'payment_intent_not_read', 'payment_intent_identity', 'mode_unverified', 'mode_mismatch', 'mode_mixed', 'charge_unexpanded', 'charge_identity', 'payment_flow_not_modeled',
  'refunds_not_read', 'refunds_truncated', 'disputes_not_read', 'disputes_truncated', 'movements_unresolved', 'budget_exhausted', 'reader_error',
] as const)
// the only signs of change the reader looks for. Their ABSENCE is not a proof of stability
export const FUNDS_READ_TEMPORAL_SIGNALS = Object.freeze(['payment_intent_changed', 'payment_intent_unverified', 'pagination_anomaly'] as const)
// what NO reading of this module verifies: a fixed, frozen list, the very same array in every report (even one that made no call)
export const FUNDS_READ_NOT_VERIFIED = Object.freeze([
  'atomicity_across_objects',            // the objects are read in different calls at different moments: Stripe offers no atomic read
  'changes_between_calls',               // except what the closing read of the payment and the model (aggregate against lists) let show
  'aba_between_open_and_close',          // a field that changed and came back (a refund that failed and was made again)
  'new_entries_after_list_read',         // entries born after a list was read that move neither the aggregate nor the flag (a second dispute; a refund in a state the aggregate does not count)
  'dispute_changes_without_flag_change', // a dispute that changes state or movements while the charge's flag stays as it was
  'changes_after_close',                 // whatever happens after the closing read
  'list_order_and_cursor_stability',     // the order of `disputes.list` is not documented; a cursor is not guaranteed stable under concurrent writes
  'mode_of_refunds_and_movements',       // Refund and BalanceTransaction do not declare `livemode` in the SDK's types
  'finality',                            // whether the position can still change: not a property of a reading
] as const)
type Reason = (typeof FUNDS_READ_STRUCTURE_REASONS)[number]
type Signal = (typeof FUNDS_READ_TEMPORAL_SIGNALS)[number]

export type FundsReading = {
  structure: {
    complete: boolean
    parts: {
      paymentIntent: 'verified' | 'not_read'
      // 'none_reported' = `latest_charge` is null: what the payment says, NOT a proof that no money moved. 'withheld' = an expanded charge that did not pass identity, type, belonging or mode
      charge: 'verified' | 'none_reported' | 'unexpanded' | 'withheld' | 'not_read'
      refunds: 'complete' | 'incomplete' | 'not_read'
      disputes: 'complete' | 'incomplete' | 'not_read'
      movements: 'resolved' | 'unresolved' | 'not_needed'
      mode: 'verified' | 'unverified' | 'mismatch' | 'mixed'
    }
    incomplete: Reason[]
  }
  temporal: {
    observation: 'no_change_observed' | 'change_observed' | 'not_verifiable'
    paymentIntentRecheck: 'same' | 'different' | 'not_done'
    pagination: 'regular' | 'anomalous'
    signals: Signal[]
    notVerified: typeof FUNDS_READ_NOT_VERIFIED
    // null when the injected clock was never read (nothing was read at all)
    startedAtMs: number | null
    finishedAtMs: number | null
    spanMs: number | null
    withinDeadline: boolean | null   // on the injected clock: informative, it is not a promise that the reading ended in time
  }
  mode: { expected: boolean | null; observed: 'test' | 'live' | 'mixed' | 'unknown' }
  failures: ReadFailure[]
  counts: { calls: number; refundPages: number; disputePages: number; movementReads: number; unresolvedMovements: number }
}
export type StripeFundsRead = { evidence: FundsEvidenceOut; reading: FundsReading }

// ---- small things ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Rec = Record<string, unknown>
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const ID_PATTERN = /^[A-Za-z0-9_]{1,255}$/
const PAYMENT_PATTERN = /^pi_[A-Za-z0-9_]{1,252}$/
const MARGIN_MS = 500
const LIMITS = { perCallTimeoutMs: [500, 60000], deadlineMs: [1000, 120000], pageSize: [1, 100], maxPages: [1, 50], maxMovementReads: [0, 100] } as const
type OptionName = keyof typeof LIMITS
// the only codes of an error that may be echoed: names of conditions, never free text
const ECHOED_CODES: readonly string[] = ['resource_missing', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE']
const NOT_A_SCALAR = '[not a scalar]'
const UNREADABLE = Symbol('unreadable')

// the fields of each object that the model reads - and nothing else is carried
const PAYMENT_KEYS = ['id', 'amount_received', 'currency', 'status', 'latest_charge'] as const
const CHARGE_KEYS = ['id', 'amount_captured', 'amount_refunded', 'currency', 'disputed', 'payment_intent'] as const
const REFUND_KEYS = ['id', 'amount', 'currency', 'status', 'payment_intent', 'charge', 'balance_transaction', 'failure_balance_transaction'] as const
const DISPUTE_KEYS = ['id', 'amount', 'currency', 'status', 'payment_intent', 'charge', 'balance_transactions'] as const
const MOVEMENT_KEYS = ['id', 'amount', 'currency', 'fee', 'net', 'reporting_category', 'source'] as const
const REFERENCE_KEYS: readonly string[] = ['latest_charge', 'payment_intent', 'charge', 'source']
const MOVEMENT_SLOTS: readonly string[] = ['balance_transaction', 'failure_balance_transaction']
const FLOW_KEYS = ['transfer_data', 'on_behalf_of', 'application_fee_amount'] as const

// a scalar is copied as it is; anything else cannot travel (nothing of its contents may), and is replaced by a marker that no id, currency, amount or status can equal
function scalar(value: unknown): unknown {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : NOT_A_SCALAR
}
// a reference to another object: an id stays an id, an expanded object is cut to its id (to nothing if it has none), a scalar stays as it is
function reference(value: unknown): unknown {
  if (isRec(value)) return 'id' in value && value.id !== undefined ? { id: scalar(value.id) } : {}
  return scalar(value)
}
function movementSlot(value: unknown): unknown {
  return isRec(value) ? project(value, MOVEMENT_KEYS) : scalar(value)
}
// the fields in the order of the list; a field that is absent (or undefined) stays absent, null stays null
function project(raw: Rec, keys: readonly string[]): Rec {
  const out: Rec = {}
  for (const key of keys) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (value === undefined) continue
    out[key] = REFERENCE_KEYS.includes(key)
      ? reference(value)
      : MOVEMENT_SLOTS.includes(key)
        ? movementSlot(value)
        : key === 'balance_transactions' ? (Array.isArray(value) ? value.map(movementSlot) : scalar(value)) : scalar(value)
  }
  return out
}
const hasFlow = (raw: Rec) => FLOW_KEYS.some((key) => raw[key] !== undefined && raw[key] !== null)
const isMovement = (value: Rec) => value.object === 'balance_transaction' && typeof value.id === 'string' && ID_PATTERN.test(value.id)
function safeGet(target: unknown, key: string): unknown {
  try {
    return typeof target === 'object' && target !== null ? (target as Rec)[key] : undefined
  } catch {
    return UNREADABLE
  }
}

// an error becomes a kind, a status and (at most) a named code - by the strings the SDK's own classes carry, never by `instanceof`, and never by their text
function classify(error: unknown): { kind: ReadFailureKind; statusCode?: number; code?: string } {
  const type = safeGet(error, 'type')
  const rawType = safeGet(error, 'rawType')
  const status = safeGet(error, 'statusCode')
  const detailCode = safeGet(safeGet(error, 'detail'), 'code')
  const statusCode = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
  let kind: ReadFailureKind = 'unknown'
  if (type === 'StripeConnectionError') kind = detailCode === 'ETIMEDOUT' ? 'timeout' : 'connection'
  else if (type === 'StripeRateLimitError' || statusCode === 429) kind = 'rate_limit'
  else if (type === 'StripeAuthenticationError' || statusCode === 401) kind = 'authentication'
  else if (type === 'StripePermissionError' || statusCode === 403) kind = 'permission'
  else if (type === 'StripeInvalidRequestError' || rawType === 'invalid_request_error' || statusCode === 400 || statusCode === 404) kind = 'invalid_request'
  else if (type === 'StripeAPIError' || rawType === 'api_error' || (statusCode !== undefined && statusCode >= 500)) kind = 'api'
  const named = [safeGet(error, 'code'), detailCode].find((value): value is string => typeof value === 'string' && ECHOED_CODES.includes(value))
  return { kind, ...(statusCode !== undefined ? { statusCode } : {}), ...(named !== undefined ? { code: named } : {}) }
}

// ---- what a reading accumulates --------------------------------------------------------------------------------------------------------------------------------------------------------------
type ListState = { status: 'complete' | 'incomplete' | 'not_read'; items: unknown[]; anomalous: boolean }
type ChargeStatus = 'verified' | 'none_reported' | 'unexpanded' | 'withheld' | 'not_read'
type Acc = {
  expected: boolean | null
  requested: RequestedRefundInput[] | null   // the copy of the caller's list, taken at the start; null = none given (or the reading was refused)
  failures: ReadFailure[]
  failureKeys: Set<string>
  reasons: Set<Reason>
  calls: number
  maxCalls: number
  refundPages: number
  disputePages: number
  movementReads: number
  unresolved: number
  references: number
  clock: number | null
  startedAt: number | null
  finishedAt: number | null
  deadlineAt: number
  halted: 'calls' | 'clock' | 'deadline' | null
  paymentVerified: boolean
  payment: Rec | null
  chargeStatus: ChargeStatus
  charge: Rec | null
  refunds: ListState | null
  disputes: ListState | null
  declared: Set<boolean>
  modeMismatch: boolean
  modeMixed: boolean
  modeUnverified: boolean
  recheck: 'same' | 'different' | 'not_done'
}
function fresh(): Acc {
  return {
    expected: null, requested: null, failures: [], failureKeys: new Set(), reasons: new Set(), calls: 0, maxCalls: 0, refundPages: 0, disputePages: 0, movementReads: 0,
    unresolved: 0, references: 0, clock: null, startedAt: null, finishedAt: null, deadlineAt: 0, halted: null, paymentVerified: false, payment: null, chargeStatus: 'not_read', charge: null,
    refunds: null, disputes: null, declared: new Set(), modeMismatch: false, modeMixed: false, modeUnverified: false, recheck: 'not_done',
  }
}
function note(acc: Acc, failure: ReadFailure) {
  const key = JSON.stringify(failure)
  if (acc.failureKeys.has(key)) return
  acc.failureKeys.add(key)
  acc.failures.push(failure)
}

// ---- the input ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Runtime = { id: string; expected: boolean; now: () => number; perCall: number; pageSize: number; maxPages: number; maxMovementReads: number; deadline: number }
function hasMethod(candidate: unknown, namespace: string, method: string): boolean {
  return typeof safeGet(safeGet(candidate, namespace), method) === 'function'
}
// the injected clock, read: a finite number, held at its highest so far; anything else is no reading (null)
function tick(acc: Acc, now: () => number): number | null {
  try {
    const value = now()
    if (typeof value === 'number' && Number.isFinite(value)) {
      acc.clock = acc.clock === null ? value : Math.max(acc.clock, value)
      return acc.clock
    }
  } catch {
    // a clock that throws is a clock that gives no reading
  }
  return null
}

// ---- the refunds the caller asked for: copied once, before anything else, or refused whole ----------------------------------------------------------------------------------------------------
// a technical limit on how much of the caller's list the reader will copy: a protection of resources, not a financial threshold. It is not a parameter and it is not exported
const MAX_REQUESTED_REFUNDS = 1000
const NONE_GIVEN = Symbol('none given')
const REFUSED = Symbol('refused')
// The list is read ONCE - its length once (and checked before a single element is touched), each index once, each of the three names once - by index and by name, never through a method of the caller's and
// never by enumeration; and what is read is what is checked and what is copied. A container that is not an array, more than the limit, a hole, an element that is not an object, a property of the wrong type, a
// getter or a Proxy that throws: the WHOLE list is refused (there is no partial copy). `undefined` is "none given"; `null` is not a list. The values are kept exactly (NaN, the infinities and -0 included): their
// domain is the funds model's.
function takeRequested(given: unknown): RequestedRefundInput[] | typeof NONE_GIVEN | typeof REFUSED {
  if (given === undefined) return NONE_GIVEN
  try {
    if (!Array.isArray(given)) return REFUSED
    const list: ReadonlyArray<unknown> = given
    const length: unknown = list.length
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > MAX_REQUESTED_REFUNDS) return REFUSED
    const copy: RequestedRefundInput[] = []
    for (let index = 0; index < length; index++) {
      const entry: unknown = list[index]
      if (!isRec(entry)) return REFUSED
      const id: unknown = entry.id
      const amount: unknown = entry.amount
      const currency: unknown = entry.currency
      if (!(id === undefined || id === null || typeof id === 'string')) return REFUSED
      if (!(amount === undefined || amount === null || typeof amount === 'number')) return REFUSED
      if (!(currency === undefined || currency === null || typeof currency === 'string')) return REFUSED
      const out: RequestedRefundInput = {}
      if (id !== undefined) out.id = id
      if (amount !== undefined) out.amount = amount
      if (currency !== undefined) out.currency = currency
      copy.push(out)
    }
    return copy
  } catch {
    return REFUSED
  }
}
function validate(acc: Acc, client: unknown, request: unknown, options: unknown): Runtime | null {
  const bad: string[] = []
  // the first thing done, before the client, the clock or anything else of the caller's is touched: the caller's requests are copied (or refused), here, in the part that precedes the first await
  const asked = isRec(request) ? takeRequested(safeGet(request, 'requestedRefunds')) : NONE_GIVEN
  if (!(hasMethod(client, 'paymentIntents', 'retrieve') && hasMethod(client, 'refunds', 'list') && hasMethod(client, 'disputes', 'list') && hasMethod(client, 'balanceTransactions', 'retrieve'))) bad.push('client')
  let id = ''
  let expected = false
  if (!isRec(request)) bad.push('request')
  else {
    const rawId = safeGet(request, 'paymentIntentId')
    if (typeof rawId === 'string' && PAYMENT_PATTERN.test(rawId)) id = rawId
    else bad.push('paymentIntentId')
    const rawMode = safeGet(request, 'expectedLivemode')
    if (typeof rawMode === 'boolean') {
      expected = rawMode
      acc.expected = rawMode
    } else bad.push('expectedLivemode')
    if (asked === REFUSED) bad.push('requestedRefunds')
  }
  let now: () => number = () => Number.NaN
  const chosen: Record<OptionName, number> = { ...FUNDS_READ_DEFAULTS }
  if (!isRec(options)) bad.push('options')
  else {
    const rawNow = safeGet(options, 'now')
    if (typeof rawNow === 'function') now = rawNow as () => number
    else bad.push('now')
    for (const name of Object.keys(LIMITS) as OptionName[]) {
      const value = safeGet(options, name)
      if (value === undefined) continue
      const [min, max] = LIMITS[name]
      if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) chosen[name] = value
      else bad.push(name)
    }
  }
  if (bad.length === 0) {
    const first = tick(acc, now)
    if (first === null) bad.push('now')
    else {
      acc.startedAt = first
      acc.deadlineAt = first + chosen.deadlineMs
    }
  }
  if (bad.length > 0) {
    for (const ref of bad) note(acc, { call: 'input', kind: 'invalid_input', ref })
    acc.reasons.add('invalid_input')
    return null
  }
  // only a reading that goes ahead keeps the copy: a refused one hands back nothing of what the caller gave
  if (Array.isArray(asked)) acc.requested = asked
  acc.maxCalls = 2 + 2 * chosen.maxPages + chosen.maxMovementReads
  return { id, expected, now, perCall: chosen.perCallTimeoutMs, pageSize: chosen.pageSize, maxPages: chosen.maxPages, maxMovementReads: chosen.maxMovementReads, deadline: chosen.deadlineMs }
}

// ---- one call: the budget first, the timeout always, never a retry --------------------------------------------------------------------------------------------------------------------------
type Called = { state: 'done'; value: unknown } | { state: 'blocked' } | { state: 'failed' }
async function call(acc: Acc, rt: Runtime, method: ReadCall, page: number | undefined, ref: string | undefined, invoke: (options: ReadRequestOptions) => Promise<unknown>): Promise<Called> {
  let timeout = 0
  if (acc.halted === null) {
    if (acc.calls >= acc.maxCalls) acc.halted = 'calls'
    else {
      const at = tick(acc, rt.now)
      if (at === null) acc.halted = 'clock'
      else {
        // never more than half of what is left once the margin is gone: the SDK may try a dropped connection once more by itself, and the deadline must still hold
        timeout = Math.min(rt.perCall, Math.floor((acc.deadlineAt - at - MARGIN_MS) / 2))
        if (timeout < 1) acc.halted = 'deadline'
      }
    }
  }
  if (acc.halted !== null) {
    note(acc, { call: method, kind: 'budget', ...(page !== undefined ? { page } : {}), ref: acc.halted })
    acc.reasons.add('budget_exhausted')
    return { state: 'blocked' }
  }
  acc.calls += 1
  try {
    return { state: 'done', value: await invoke({ timeout, maxNetworkRetries: 0 }) }
  } catch (error) {
    note(acc, { call: method, ...(page !== undefined ? { page } : {}), ...classify(error), ...(ref !== undefined ? { ref } : {}) })
    return { state: 'failed' }
  }
}

// ---- the payment and its charge ----------------------------------------------------------------------------------------------------------------------------------------------------------
type ChargeRead =
  | { status: 'none_reported' }
  | { status: 'unexpanded' }
  | { status: 'withheld'; cause: 'identity' | 'unverified' | 'mixed'; declared: boolean | null }
  | { status: 'verified'; charge: Rec; declared: boolean; flow: boolean }
type PaymentRead =
  | { status: 'rejected'; cause: 'malformed' | 'identity' | 'unverified' | 'mismatch'; declared: boolean | null }
  | { status: 'usable'; payment: Rec; declared: boolean; flow: boolean; charge: ChargeRead }
function readCharge(latest: unknown, paymentId: string, expected: boolean): ChargeRead {
  if (latest === null) return { status: 'none_reported' }
  if (!isRec(latest)) return { status: 'unexpanded' }
  const names = latest.payment_intent
  const belongs = names === paymentId || (isRec(names) && names.id === paymentId)
  if (latest.object !== 'charge' || typeof latest.id !== 'string' || !ID_PATTERN.test(latest.id) || !belongs) return { status: 'withheld', cause: 'identity', declared: null }
  const declared = latest.livemode
  if (typeof declared !== 'boolean') return { status: 'withheld', cause: 'unverified', declared: null }
  if (declared !== expected) return { status: 'withheld', cause: 'mixed', declared }
  return { status: 'verified', charge: project(latest, CHARGE_KEYS), declared, flow: hasFlow(latest) }
}
function readPayment(value: unknown, id: string, expected: boolean): PaymentRead {
  try {
    if (!isRec(value)) return { status: 'rejected', cause: 'malformed', declared: null }
    if (value.id !== id || value.object !== 'payment_intent') return { status: 'rejected', cause: 'identity', declared: null }
    const declared = value.livemode
    if (typeof declared !== 'boolean') return { status: 'rejected', cause: 'unverified', declared: null }
    if (declared !== expected) return { status: 'rejected', cause: 'mismatch', declared }
    return { status: 'usable', payment: project(value, PAYMENT_KEYS), declared, flow: hasFlow(value), charge: readCharge(value.latest_charge, id, expected) }
  } catch {
    return { status: 'rejected', cause: 'malformed', declared: null }
  }
}
// what a rejected payment says: the failure, and why the structure is incomplete
function reject(acc: Acc, read: Extract<PaymentRead, { status: 'rejected' }>) {
  const kind: ReadFailureKind = read.cause === 'malformed' ? 'malformed_response' : read.cause === 'identity' ? 'identity_mismatch' : read.cause === 'unverified' ? 'mode_unverified' : 'mode_mismatch'
  note(acc, { call: 'paymentIntents.retrieve', kind })
  // an answer that is not an object makes the FIRST read a payment that was not read; the closing read can only fail to confirm (that is reported by the recheck)
  if (read.cause === 'malformed') {
    if (!acc.paymentVerified) acc.reasons.add('payment_intent_not_read')
  } else if (read.cause === 'identity') acc.reasons.add('payment_intent_identity')
  else if (read.cause === 'unverified') {
    acc.reasons.add('mode_unverified')
    acc.modeUnverified = true
  } else {
    acc.declared.add(read.declared as boolean)
    // the very first payment that does not match is a mismatch; a LATER read that does not match the first is the objects disagreeing
    if (acc.paymentVerified) {
      acc.reasons.add('mode_mixed')
      acc.modeMixed = true
    } else {
      acc.reasons.add('mode_mismatch')
      acc.modeMismatch = true
    }
  }
}
// what a charge says about the structure (the same whether it comes with the first read or with the closing one)
function judgeCharge(acc: Acc, charge: ChargeRead) {
  if (charge.status === 'unexpanded') acc.reasons.add('charge_unexpanded')
  else if (charge.status === 'withheld') {
    if (charge.cause === 'identity') {
      acc.reasons.add('charge_identity')
      note(acc, { call: 'paymentIntents.retrieve', kind: 'identity_mismatch', ref: 'latest_charge' })
    } else if (charge.cause === 'unverified') {
      acc.reasons.add('mode_unverified')
      acc.modeUnverified = true
      note(acc, { call: 'paymentIntents.retrieve', kind: 'mode_unverified', ref: 'latest_charge' })
    } else {
      acc.reasons.add('mode_mixed')
      acc.modeMixed = true
      acc.declared.add(charge.declared as boolean)
      note(acc, { call: 'paymentIntents.retrieve', kind: 'mode_mismatch', ref: 'latest_charge' })
    }
  } else if (charge.status === 'verified' && charge.flow) acc.reasons.add('payment_flow_not_modeled')
}

// ---- lists: walked page by page, by hand ------------------------------------------------------------------------------------------------------------------------------------------------------------
type Page = { items: unknown[]; ids: string[]; hasMore: boolean; last: unknown; unresolved: number; references: number; declared: boolean[]; modeMixed: boolean; modeUnverified: boolean }
// a page is a record with a `data` array of at most `limit` entries and a boolean `has_more` (and not empty if there is more). Everything is read inside a guard: an object that cannot be read is malformed
function readPage(value: unknown, kind: 'refunds' | 'disputes', limit: number, expected: boolean): Page | null {
  try {
    if (!isRec(value) || !Array.isArray(value.data) || typeof value.has_more !== 'boolean') return null
    const data: unknown[] = value.data
    if (data.length > limit || (value.has_more && data.length === 0)) return null
    const page: Page = { items: [], ids: [], hasMore: value.has_more, last: data[data.length - 1], unresolved: 0, references: 0, declared: [], modeMixed: false, modeUnverified: false }
    for (let index = 0; index < data.length; index++) {
      const entry = data[index]
      if (!isRec(entry)) {
        page.items.push(scalar(entry))
        if (kind === 'disputes') page.modeUnverified = true
        continue
      }
      if (typeof entry.id === 'string' && ID_PATTERN.test(entry.id)) page.ids.push(entry.id)
      if (kind === 'refunds') {
        page.items.push(project(entry, REFUND_KEYS))
        for (const slot of MOVEMENT_SLOTS) {
          const cited = entry[slot]
          if (cited === null || cited === undefined) continue
          page.references += 1
          // an id is read later; an object that came inline must be a balance transaction; anything else cannot be read
          if (typeof cited === 'string') continue
          if (!isRec(cited) || !isMovement(cited)) page.unresolved += 1
        }
      } else {
        page.items.push(project(entry, DISPUTE_KEYS))
        const mode = entry.livemode
        if (typeof mode !== 'boolean') page.modeUnverified = true
        else {
          page.declared.push(mode)
          if (mode !== expected) page.modeMixed = true
        }
        const movements = entry.balance_transactions
        if (!Array.isArray(movements)) {
          page.references += 1
          page.unresolved += 1
        } else {
          for (let at = 0; at < movements.length; at++) {
            const cited = movements[at]
            page.references += 1
            if (!isRec(cited) || !isMovement(cited)) page.unresolved += 1
          }
        }
      }
    }
    return page
  } catch {
    return null
  }
}
async function walk(acc: Acc, rt: Runtime, client: StripeFundsClient, kind: 'refunds' | 'disputes'): Promise<ListState> {
  const method: ReadCall = kind === 'refunds' ? 'refunds.list' : 'disputes.list'
  const state: ListState = { status: 'not_read', items: [], anomalous: false }
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  let modeProblem = false
  // how a walk ends when it did not reach the end of the list: a list of which NOTHING usable came is not read; one that was cut keeps what was read
  const ended = (status: 'not_read' | 'incomplete'): ListState => {
    state.status = status
    acc.reasons.add(status === 'not_read' ? (kind === 'refunds' ? 'refunds_not_read' : 'disputes_not_read') : kind === 'refunds' ? 'refunds_truncated' : 'disputes_truncated')
    return state
  }
  for (;;) {
    if (pages >= rt.maxPages) {
      note(acc, { call: method, kind: 'budget', page: pages + 1, ref: 'pages' })
      return ended('incomplete')
    }
    const page = pages + 1
    const params = cursor === undefined ? { payment_intent: rt.id, limit: rt.pageSize } : { payment_intent: rt.id, limit: rt.pageSize, starting_after: cursor }
    const got = await call(acc, rt, method, page, undefined, (options) => (kind === 'refunds' ? client.refunds.list(params, options) : client.disputes.list(params, options)))
    // blocked by the budget before the first page: nothing was attempted and the budget is the reason; blocked later: what was read is kept
    if (got.state === 'blocked') return pages === 0 ? state : ended('incomplete')
    pages += 1
    if (kind === 'refunds') acc.refundPages += 1
    else acc.disputePages += 1
    if (got.state === 'failed') return pages === 1 ? ended('not_read') : ended('incomplete')
    const read = readPage(got.value, kind, rt.pageSize, rt.expected)
    if (read === null) {
      note(acc, { call: method, kind: 'malformed_response', page })
      return pages === 1 ? ended('not_read') : ended('incomplete')
    }
    // the page is good, and it is taken WHOLE: every entry as it came, in the order it came, repeated or foreign or not
    state.items.push(...read.items)
    acc.unresolved += read.unresolved
    acc.references += read.references
    const known = seen.size
    for (const id of read.ids) {
      if (seen.has(id)) state.anomalous = true
      else seen.add(id)
    }
    for (const declared of read.declared) acc.declared.add(declared)
    if (read.modeMixed) {
      modeProblem = true
      acc.modeMixed = true
      acc.reasons.add('mode_mixed')
      note(acc, { call: method, kind: 'mode_mismatch', page })
    }
    if (read.modeUnverified) {
      modeProblem = true
      acc.modeUnverified = true
      acc.reasons.add('mode_unverified')
      note(acc, { call: method, kind: 'mode_unverified', page })
    }
    if (!read.hasMore) {
      state.status = modeProblem ? 'incomplete' : 'complete'
      return state
    }
    // more to read: the cursor is the id of the last entry, it must be one never asked for, and the page must have shown an entry never seen - otherwise the walk goes round in circles
    const last = read.last
    const next = isRec(last) && typeof last.id === 'string' && ID_PATTERN.test(last.id) ? last.id : null
    if (next === null || cursors.has(next) || seen.size === known) {
      note(acc, { call: method, kind: 'malformed_response', page, ref: 'cursor' })
      return ended('incomplete')
    }
    cursors.add(next)
    cursor = next
  }
}

// ---- the balance transactions of the refunds: read by id, once each --------------------------------------------------------------------------------------------------------------------------
async function readMovement(acc: Acc, rt: Runtime, client: StripeFundsClient, id: string): Promise<Rec | null> {
  const got = await call(acc, rt, 'balanceTransactions.retrieve', undefined, id, (options) => client.balanceTransactions.retrieve(id, {}, options))
  if (got.state !== 'blocked') acc.movementReads += 1
  if (got.state !== 'done') return null
  try {
    const value = got.value
    if (!isRec(value)) {
      note(acc, { call: 'balanceTransactions.retrieve', kind: 'malformed_response', ref: id })
      return null
    }
    if (value.id !== id || value.object !== 'balance_transaction') {
      note(acc, { call: 'balanceTransactions.retrieve', kind: 'identity_mismatch', ref: id })
      return null
    }
    return project(value, MOVEMENT_KEYS)
  } catch {
    note(acc, { call: 'balanceTransactions.retrieve', kind: 'malformed_response', ref: id })
    return null
  }
}
// An id is not a movement that was seen: every id the refunds name is read, and one that is not read leaves the reading incomplete. The refunds that did not succeed come first (they decide whether money
// came back) and their two movements are a pair - if the first cannot be read the second is not asked for. The same id cited twice is read once. The movements of a DISPUTE come inline and are never read here.
async function resolveMovements(acc: Acc, rt: Runtime, client: StripeFundsClient): Promise<void> {
  const refunds = acc.refunds === null ? [] : acc.refunds.items.filter(isRec)
  const settled = (status: unknown) => status === 'succeeded' || status === 'pending' || status === 'requires_action'
  const urgent = new Set(refunds.filter((refund) => !settled(refund.status)))
  const cache = new Map<string, Rec | null>()
  for (const refund of [...refunds.filter((entry) => urgent.has(entry)), ...refunds.filter((entry) => !urgent.has(entry))]) {
    const paired = urgent.has(refund)
    let broken = false
    for (const slot of MOVEMENT_SLOTS) {
      const cited = refund[slot]
      if (typeof cited !== 'string') continue
      if (!ID_PATTERN.test(cited) || (paired && broken)) {
        acc.unresolved += 1
        continue
      }
      let movement = cache.get(cited)
      if (movement === undefined) {
        if (acc.movementReads >= rt.maxMovementReads) {
          note(acc, { call: 'balanceTransactions.retrieve', kind: 'budget', ref: 'movements' })
          acc.unresolved += 1
          broken = paired
          continue
        }
        movement = await readMovement(acc, rt, client, cited)
        cache.set(cited, movement)
      }
      if (movement === null) {
        acc.unresolved += 1
        broken = paired
        continue
      }
      refund[slot] = project(movement, MOVEMENT_KEYS)
    }
  }
  if (acc.unresolved > 0) acc.reasons.add('movements_unresolved')
}

// ---- the reading -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// what the model reads of the payment and of its charge, as text: two reads are the same only if every one of those fields is
// (JSON alone would write NaN, Infinity and null alike, and 0 and -0 alike: those are told apart here)
const exactly = (_key: string, value: unknown) => (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)) ? `number:${Object.is(value, -0) ? '-0' : String(value)}` : value)
const fingerprint = (read: Extract<PaymentRead, { status: 'usable' }>) =>
  JSON.stringify([read.payment, read.charge.status, read.charge.status === 'verified' ? read.charge.charge : null], exactly)
async function perform(acc: Acc, client: StripeFundsClient, request: unknown, options: unknown): Promise<void> {
  const rt = validate(acc, client, request, options)
  if (rt === null) return
  try {
    // 1. the payment, with its charge expanded
    const opened = await call(acc, rt, 'paymentIntents.retrieve', undefined, undefined, (callOptions) => client.paymentIntents.retrieve(rt.id, { expand: ['latest_charge'] }, callOptions))
    if (opened.state === 'failed') acc.reasons.add('payment_intent_not_read')
    if (opened.state !== 'done') return
    const first = readPayment(opened.value, rt.id, rt.expected)
    if (first.status === 'rejected') {
      reject(acc, first)
      return
    }
    acc.paymentVerified = true
    acc.declared.add(first.declared)
    acc.payment = first.payment
    acc.chargeStatus = first.charge.status
    acc.charge = first.charge.status === 'verified' ? first.charge.charge : null
    if (first.flow) acc.reasons.add('payment_flow_not_modeled')
    judgeCharge(acc, first.charge)
    // 2. the refunds, then the disputes (the disputes are read even if the refunds could not be), then the movements the refunds name
    acc.refunds = await walk(acc, rt, client, 'refunds')
    acc.disputes = await walk(acc, rt, client, 'disputes')
    await resolveMovements(acc, rt, client)
    // 3. the closing read of the payment - only if nothing is missing already. It is a sign of change, not a proof of anything: it compares the fields the model reads of the payment and of its charge
    if (acc.reasons.size > 0) return
    const closing = await call(acc, rt, 'paymentIntents.retrieve', undefined, undefined, (callOptions) => client.paymentIntents.retrieve(rt.id, { expand: ['latest_charge'] }, callOptions))
    if (closing.state !== 'done') return
    const again = readPayment(closing.value, rt.id, rt.expected)
    if (again.status === 'rejected') {
      reject(acc, again)
      return
    }
    if (again.flow) acc.reasons.add('payment_flow_not_modeled')
    // the charge of the closing read: a flow, or a mode that is not the expected one, is said as the first read's charge says it; any other change of the charge is only a difference (the recheck)
    if (again.charge.status === 'verified' || (again.charge.status === 'withheld' && again.charge.cause !== 'identity')) judgeCharge(acc, again.charge)
    acc.recheck = fingerprint(first) === fingerprint(again) ? 'same' : 'different'
    // the evidence of the payment and of its charge is the CLOSING read's (the latest), if its charge is one the model can use
    if (again.charge.status === 'verified' || again.charge.status === 'none_reported') {
      acc.payment = again.payment
      acc.chargeStatus = again.charge.status
      acc.charge = again.charge.status === 'verified' ? again.charge.charge : null
    }
  } finally {
    tick(acc, rt.now)
    acc.finishedAt = acc.clock
  }
}

// ---- the report ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const NOT_READ_PARTS = { paymentIntent: 'not_read', charge: 'not_read', refunds: 'not_read', disputes: 'not_read', movements: 'not_needed', mode: 'unverified' } as const
function observedMode(acc: Acc): 'test' | 'live' | 'mixed' | 'unknown' {
  if (acc.declared.size === 0) return 'unknown'
  if (acc.declared.size === 2) return 'mixed'
  return acc.declared.has(true) ? 'live' : 'test'
}
function times(acc: Acc) {
  const both = acc.startedAt !== null && acc.finishedAt !== null
  return {
    startedAtMs: acc.startedAt,
    finishedAtMs: acc.finishedAt,
    spanMs: both ? (acc.finishedAt as number) - (acc.startedAt as number) : null,
    withinDeadline: both ? (acc.finishedAt as number) <= acc.deadlineAt : null,
  }
}
function counts(acc: Acc) {
  return { calls: acc.calls, refundPages: acc.refundPages, disputePages: acc.disputePages, movementReads: acc.movementReads, unresolvedMovements: acc.unresolved }
}
function report(acc: Acc): StripeFundsRead {
  const incomplete = FUNDS_READ_STRUCTURE_REASONS.filter((reason) => acc.reasons.has(reason))
  const anomalous = acc.refunds?.anomalous === true || acc.disputes?.anomalous === true
  const signals = FUNDS_READ_TEMPORAL_SIGNALS.filter((signal) => (signal === 'payment_intent_changed' ? acc.recheck === 'different' : signal === 'payment_intent_unverified' ? acc.recheck === 'not_done' : anomalous))
  const observation = acc.recheck === 'different' || anomalous ? 'change_observed' : acc.recheck === 'same' ? 'no_change_observed' : 'not_verifiable'
  // the combination that cannot be ignored: unless the structure is complete AND no change was observed, both lists say "there is more"
  const clean = incomplete.length === 0 && observation === 'no_change_observed'
  const listOut = (state: ListState | null) => (state === null || state.status === 'not_read' ? null : { data: state.items as never[], has_more: !clean })
  const evidence: FundsEvidenceOut = { paymentIntent: acc.payment as PaymentIntentOut | null, charge: acc.charge as ChargeOut | null, refunds: listOut(acc.refunds), disputes: listOut(acc.disputes) }
  if (acc.requested !== null) evidence.requestedRefunds = acc.requested
  const listPart = (state: ListState | null) => (state === null ? 'not_read' : state.status)
  return {
    evidence,
    reading: {
      structure: {
        complete: incomplete.length === 0,
        parts: {
          paymentIntent: acc.paymentVerified ? 'verified' : 'not_read',
          charge: acc.chargeStatus,
          refunds: listPart(acc.refunds),
          disputes: listPart(acc.disputes),
          movements: acc.references === 0 ? 'not_needed' : acc.unresolved > 0 ? 'unresolved' : 'resolved',
          mode: acc.modeMismatch ? 'mismatch' : acc.modeMixed ? 'mixed' : acc.modeUnverified || !acc.paymentVerified ? 'unverified' : 'verified',
        },
        incomplete,
      },
      temporal: { observation, paymentIntentRecheck: acc.recheck, pagination: anomalous ? 'anomalous' : 'regular', signals, notVerified: FUNDS_READ_NOT_VERIFIED, ...times(acc) },
      mode: { expected: acc.expected, observed: observedMode(acc) },
      failures: acc.failures,
      counts: counts(acc),
    },
  }
}
// the last resort: something the reader did not foresee went wrong. Nothing that was half-read is handed over: the evidence is "not read" and the report says so
function reportFailure(acc: Acc): StripeFundsRead {
  const failures: ReadFailure[] = [...acc.failures, { call: 'reader', kind: 'internal_error' }]
  const evidence: FundsEvidenceOut = { paymentIntent: null, charge: null, refunds: null, disputes: null }
  if (acc.requested !== null) evidence.requestedRefunds = acc.requested
  return {
    evidence,
    reading: {
      structure: { complete: false, parts: { ...NOT_READ_PARTS }, incomplete: ['reader_error'] },
      temporal: { observation: 'not_verifiable', paymentIntentRecheck: 'not_done', pagination: 'regular', signals: ['payment_intent_unverified'], notVerified: FUNDS_READ_NOT_VERIFIED, ...times(acc) },
      mode: { expected: acc.expected, observed: 'unknown' },
      failures,
      counts: counts(acc),
    },
  }
}

// ---- the entry ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Never rejects: a reading that could not be done is a report that says so. `request` and `options` are read, never touched; the answers of the client are read, never touched.
export async function readStripeFundsEvidence(client: StripeFundsClient, request: FundsReadRequest, options: FundsReadOptions): Promise<StripeFundsRead> {
  const acc = fresh()
  try {
    await perform(acc, client, request, options)
    return report(acc)
  } catch {
    return reportFailure(acc)
  }
}
