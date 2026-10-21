// The position of the FUNDS of ONE Stripe payment (step 4.6, S6, P1) - a pure function over evidence that somebody already read from Stripe.
//
// WHAT IT ANSWERS: "how much of the money collected for this payment is still held, as far as the evidence shows - and how sure is that?" In whole cents, as an INTERVAL
// [retainedLowerCents, retainedUpperCents] and a certainty: 'proven' (what the evidence shows leaves one figure) or 'uncertain' (it does not). The interval is the position AS OF
// THE EVIDENCE, a snapshot: a refund that succeeded can still fail (AR-2, scenario B), so a figure that depends on one is `provisional` and the position is never `final`.
//
// THREE THINGS KEPT APART
//   * CAPITAL: the money of the payment. Collected = `amount_received` of a PaymentIntent that succeeded. It leaves by REFUNDS (the amount of the refund) and by DISPUTES (the amount
//     really WITHDRAWN, minus what was REINSTATED). Both are read as gross movements: the `amount` of a balance transaction, never its `net`.
//   * FEES: the `fee` of a balance transaction (a dispute fee, a refund fee). Reported on their own, NEVER taken from the capital, whatever their size (SP1, Test Mode: a withdrawal of
//     -100 with a fee of 2000, net -2100, on a payment of 1.00). No amount of fee is written in this file: it depends on the country and the account.
//   * UNCERTAINTY: what the evidence does not settle. It is said, never guessed: a list that was not read is not an empty list; a state nobody modeled is not a harmless one; the word
//     "won" is not "the funds are back"; a charge that says "disputed" is not a dispute; an id that is not expanded is not a movement that was seen. The WORST reading of every uncertain
//     thing gives the lower bound, the BEST reading gives the upper bound. A conflict (evidence that contradicts itself, or belongs to another payment) gives the widest interval.
//
// AGGREGATE vs SINGLE REFUNDS: `Charge.amount_refunded` is a SIGNAL, never an addend and never the proof of one refund's state (AR-2: it already counts a pending refund, and it goes back
// DOWN when a succeeded refund fails). It is compared with the refunds listed: the worst case takes the larger figure, the best case the smaller. The same refund is never counted twice
// (as a listed refund, as its balance movement, in the aggregate, as a request): refunds and movements are identified by their id, never by looking alike.
//
// ONE ID, ONE REFUND: an id names a single refund, so everything said about it must agree - the refund Stripe lists under it and every request that names it. Requests that say the same
// (the same amount, the same currency) are one request, and a request that says what Stripe lists is that refund, counted once. Two descriptions that differ are a CONTRADICTION (a
// conflict: the widest interval), never reconciled quietly and never settled by the order of a list.
//
// OBSERVED IN TEST MODE vs PRUDENCE OF THE PROJECT (docs/VERIFICA-4.6.md S6a.17-S6a.19)
//   * observed: a pending refund is already inside `amount_refunded`; a succeeded refund can fail, `amount_refunded` goes back down and the refund shows -20 / +20 (fee 0); a dispute
//     withdraws the disputed amount with a separate fee, a won dispute reinstates the amount and the fee is not given back; `Charge.disputed` stays true after a win.
//   * prudence, never observed: the refund statuses `requires_action` and `canceled`; the dispute statuses `warning_*` and `prevented`; the exact `reporting_category` values of the
//     balance transactions of a dispute (`dispute` for the withdrawal, `dispute_reversal` for the reinstatement, from Stripe's public documentation); "a failed refund without any balance
//     transaction never moved money". Each is handled so that it cannot grant anything.
//
// WHAT IT IS NOT: it decides nothing and it is connected to nothing (no release decision, no payment hold, no route, no webhook). It does not call Stripe, read a database, a clock or
// the environment, and it modifies nothing it is given. It authorizes nothing: "at least X is held" is answered from the worst reading, "nothing is held" only for a position that is PROVEN
// and FINAL, and everything else is 'unknown' (the two questions at the end of this file). No import: not even a type. `tests/payment-hold-evidence.test.ts` proves the model and guards
// that nothing of the application uses it yet.
//
// ZERO IN THE SNAPSHOT vs ZERO TO RELY ON: a proven position whose figure is zero says "nothing is held, as far as the evidence shows NOW". When that zero rests on a refund that succeeded
// (`final` is false) the refund can still fail (AR-2, scenario B: the money comes back and the capital is whole again), so it is a zero of the snapshot and not one to base a decision that
// cannot be undone on. Only a zero that is also FINAL - no succeeded refund behind it: a payment that was never collected, or one taken by disputes that were lost - is a 'yes' to "is nothing
// held?". Something held for sure stays a 'no', final or not: a refund that fails can only give money back.

// ---- the evidence (what a caller read from Stripe) ----------------------------------------------------------------------------------------------------------------------
// Structural types in the SDK's own (snake_case) names, so that a Stripe.PaymentIntent, Charge, Refund, Dispute, BalanceTransaction or ApiList can be passed as it is. Every field is
// optional and may be wrong at run time: what cannot be used is reported, never assumed.
type Reference = string | { id?: string | null } | null
export type BalanceTransactionEvidence = {
  id?: string | null
  amount?: number | null
  currency?: string | null
  fee?: number | null
  net?: number | null
  reporting_category?: string | null
  source?: Reference
}
export type PaymentIntentEvidence = {
  id?: string | null
  amount_received?: number | null
  currency?: string | null
  status?: string | null
  latest_charge?: Reference
}
export type ChargeEvidence = {
  id?: string | null
  amount_captured?: number | null
  amount_refunded?: number | null
  currency?: string | null
  disputed?: boolean | null
  payment_intent?: Reference
}
export type RefundEvidence = {
  id?: string | null
  amount?: number | null
  currency?: string | null
  status?: string | null
  payment_intent?: Reference
  charge?: Reference
  balance_transaction?: string | BalanceTransactionEvidence | null
  failure_balance_transaction?: string | BalanceTransactionEvidence | null
}
export type DisputeEvidence = {
  id?: string | null
  amount?: number | null
  currency?: string | null
  status?: string | null
  payment_intent?: Reference
  charge?: Reference
  balance_transactions?: ReadonlyArray<string | BalanceTransactionEvidence> | null
}
export type ListEvidence<T> = { data?: ReadonlyArray<T> | null; has_more?: boolean | null }
// A refund the application asked for and that Stripe does not list (yet): an intention, not a Stripe object. `id` is the Stripe refund id once it is known.
export type RequestedRefundEvidence = { id?: string | null; amount?: number | null; currency?: string | null }
export type FundsEvidence = {
  paymentIntent?: PaymentIntentEvidence | null
  charge?: ChargeEvidence | null
  refunds?: ListEvidence<RefundEvidence> | null
  disputes?: ListEvidence<DisputeEvidence> | null
  requestedRefunds?: ReadonlyArray<RequestedRefundEvidence> | null
}

// ---- the findings: what the model says about the evidence --------------------------------------------------------------------------------------------------------------
// uncertainty: the evidence is incomplete or leaves it open        -> the position is 'uncertain'
// conflict:    the evidence contradicts itself, or is not this payment's, or is not valid -> the position is 'uncertain', with the widest interval
// anomaly:     a fact worth reporting that does not make the arithmetic uncertain
// note:        something that was done or not observed (a duplicate removed, a state never seen in Test Mode)
export type FundsFindingKind = 'uncertainty' | 'conflict' | 'anomaly' | 'note'
const TABLE = {
  payment_intent_missing: { kind: 'uncertainty', detail: 'The payment was not read: nothing can be attributed to it and nothing is known about its money.' },
  payment_open: { kind: 'uncertainty', detail: 'The payment is not paid yet: nothing is collected so far, and money may still arrive.' },
  payment_in_motion: { kind: 'uncertainty', detail: 'The payment is on its way (processing, or authorized and not captured): the amount that will be collected is not known.' },
  payment_status_unknown: { kind: 'uncertainty', detail: 'The payment is in a status the model does not know: nothing is assumed about its money.' },
  refunds_not_read: { kind: 'uncertainty', detail: 'The refunds were not read. A list that was not read is not an empty list: any of the money may have been refunded.' },
  refunds_incomplete: { kind: 'uncertainty', detail: 'The list of refunds is not complete (more pages, or it does not say): refunds that were not listed may exist.' },
  refund_total_not_read: { kind: 'uncertainty', detail: 'The total refunded that the charge reports was not read: the refunds listed have nothing to be checked against.' },
  refund_in_flight: { kind: 'uncertainty', detail: 'A refund is pending or waits for an action: the money may leave. It counts in the worst case only.' },
  refund_state_unknown: { kind: 'uncertainty', detail: 'A refund is in a status the model does not know: it may be money that leaves. It counts in the worst case only.' },
  refund_requested: { kind: 'uncertainty', detail: 'A refund was requested and Stripe does not list it (yet): it may exist. It counts in the worst case only.' },
  refunded_amount_unexplained: { kind: 'uncertainty', detail: 'The charge reports more refunded than the refunds listed explain: refunded money without a refund behind it.' },
  refunded_amount_lagging: { kind: 'uncertainty', detail: 'The charge reports less refunded than the succeeded refunds listed: one of the two readings is out of date.' },
  refund_reversal_unproven: { kind: 'uncertainty', detail: 'A failed or canceled refund does not show that the money came back (or never left): it may still be out.' },
  refund_movements_unreadable: { kind: 'uncertainty', detail: 'The balance transactions of a failed or canceled refund were not read (ids only): whether the money came back is not shown.' },
  disputes_not_read: { kind: 'uncertainty', detail: 'The disputes were not read. A list that was not read is not an empty list: funds may have been withdrawn.' },
  disputes_incomplete: { kind: 'uncertainty', detail: 'The list of disputes is not complete (more pages, or it does not say): disputes that were not listed may exist.' },
  dispute_state_unknown: { kind: 'uncertainty', detail: 'Whether the charge is disputed was not read: the disputes listed have nothing to be checked against.' },
  disputed_charge_without_dispute: { kind: 'uncertainty', detail: 'The charge says it is disputed and no dispute of this payment is listed: funds may be withdrawn and nothing says how much.' },
  dispute_open: { kind: 'uncertainty', detail: 'A dispute is open: the disputed amount may be withdrawn or given back.' },
  dispute_won_funds_not_returned: { kind: 'uncertainty', detail: 'A dispute is won but the withdrawn funds are not (all) shown as reinstated: "won" does not prove the funds are back.' },
  dispute_won_funds_not_shown: { kind: 'uncertainty', detail: 'A dispute is won and no movement of funds is shown: whether anything was withdrawn or reinstated is not known.' },
  dispute_lost_without_withdrawal: { kind: 'uncertainty', detail: 'A dispute is lost and no withdrawal is shown: "lost" and "closed" do not make it harmless.' },
  dispute_withdrawal_incomplete: { kind: 'uncertainty', detail: 'A dispute is lost and the withdrawn funds shown are less than the disputed amount.' },
  dispute_status_not_modeled: { kind: 'uncertainty', detail: 'A dispute is in a status the model does not know (or has never seen): the disputed amount may be gone.' },
  dispute_movements_not_read: { kind: 'uncertainty', detail: 'The balance transactions of a dispute were not read: what was withdrawn or reinstated is not known.' },
  dispute_movements_unreadable: { kind: 'uncertainty', detail: 'Some balance transactions of a dispute are ids that were not read: what they moved is not known.' },
  invalid_evidence: { kind: 'conflict', detail: 'Evidence is not what it must be (not an object, not a list, or it cannot be read at all).' },
  invalid_identifier: { kind: 'conflict', detail: 'An identifier is missing or malformed: what cannot be named cannot be counted once.' },
  invalid_amount: { kind: 'conflict', detail: 'An amount is not a whole number of cents of the expected sign, or a sum leaves the safe integers.' },
  invalid_currency: { kind: 'conflict', detail: 'A currency is missing or is not a three-letter code.' },
  currency_mismatch: { kind: 'conflict', detail: 'A refund, dispute, charge or movement is in another currency than the payment: nothing is converted.' },
  foreign_evidence: { kind: 'conflict', detail: 'Evidence that belongs to another payment, charge, refund or dispute: it is set aside and never counted.' },
  unattributable_evidence: { kind: 'conflict', detail: 'Evidence that names neither this payment nor its charge: it cannot be attributed and is set aside.' },
  conflicting_duplicate: { kind: 'conflict', detail: 'The same identifier is described in two different ways (or used by two objects): nothing is concluded from it.' },
  balance_transaction_inconsistent: { kind: 'conflict', detail: 'A balance transaction contradicts its refund or itself (amount, sign, net different from amount minus fee).' },
  unrecognized_movement: { kind: 'conflict', detail: 'A balance transaction of a dispute is not a withdrawal or a reinstatement the model recognizes: it is not guessed.' },
  charge_mismatch: { kind: 'conflict', detail: 'The charge is not provably the charge of this payment (other payment, other id, other amount captured).' },
  dispute_flag_mismatch: { kind: 'conflict', detail: 'The charge says it is not disputed and a dispute of this payment is listed.' },
  dispute_amounts_inconsistent: { kind: 'conflict', detail: 'The amounts of a dispute contradict each other (more withdrawn than disputed, more reinstated than withdrawn, a lost dispute with a reinstatement).' },
  over_recovered: { kind: 'anomaly', detail: 'Refunded and withdrawn together exceed what was collected: the customer recovered more than they paid. A person must look.' },
  duplicate_removed: { kind: 'note', detail: 'The same object was listed more than once, identically: it was counted once.' },
  state_not_observed: { kind: 'note', detail: 'A state that was never seen in Test Mode (requires_action, canceled): handled prudently and not declared verified.' },
} as const satisfies Record<string, { kind: FundsFindingKind; detail: string }>
export type FundsFindingCode = keyof typeof TABLE
// code -> kind: the list of what the model can say, for tests and for readers
export const FUNDS_FINDING_CODES = Object.freeze(Object.fromEntries(Object.entries(TABLE).map(([code, entry]) => [code, entry.kind]))) as unknown as { readonly [Code in FundsFindingCode]: (typeof TABLE)[Code]['kind'] }
export type FundsFinding = { kind: FundsFindingKind; code: FundsFindingCode; ref: string | null; detail: string }

// ---- the position ---------------------------------------------------------------------------------------------------------------------------------------------------------------
export type RefundOutcome = 'effective' | 'in_flight' | 'not_effective' | 'unknown' | 'excluded'
export type DisputePhase = 'open' | 'won' | 'lost' | 'unmodeled' | 'excluded'
export type RefundItem = { id: string; amountCents: number; status: string | null; outcome: RefundOutcome; feeCents: number }
export type DisputeItem = { id: string; amountCents: number; status: string | null; phase: DisputePhase; withdrawnCents: number; reinstatedCents: number; feeCents: number }
export type FundsPosition = {
  currency: string | null
  certainty: 'proven' | 'uncertain'
  // proven, and no refund that succeeded can still fail. A zero that is not final is zero in the snapshot only: "is nothing held?" says yes to a final zero and to nothing else
  final: boolean
  collectedCents: number | null
  // the money held, at least (every uncertain thing at its worst) and at most (every uncertain thing at its best); null = no upper limit is known
  retainedLowerCents: number
  retainedUpperCents: number | null
  // the one figure, only for a proven position whose bounds meet
  retainedCents: number | null
  overRecoveredCents: number
  provisionalRefundCents: number
  refunds: { confirmedCents: number; inFlightCents: number; unknownCents: number; requestedCents: number; reversedCents: number; reportedByChargeCents: number | null; items: RefundItem[] }
  // fundsGoneLowerCents is what leaves for the LOWER retained bound (the worst reading), fundsGoneUpperCents for the UPPER bound (the best reading)
  disputes: { withdrawnCents: number; reinstatedCents: number; fundsGoneLowerCents: number; fundsGoneUpperCents: number; items: DisputeItem[] }
  fees: { disputeCents: number; refundCents: number; totalCents: number; complete: boolean }
  findings: FundsFinding[]
}
export type Tri = 'yes' | 'no' | 'unknown'

// ---- readers -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Rec = Record<string, unknown>
const ID_PATTERN = /^[A-Za-z0-9_]{1,255}$/
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/
const STATUS_PATTERN = /^[a-z_]{1,40}$/
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const absent = (value: unknown) => value === undefined || value === null
const plainId = (value: unknown): string | null => (typeof value === 'string' && ID_PATTERN.test(value) ? value : null)
// whole cents: a safe integer ("minus zero" is zero); anything else is null
const cents = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value + 0 : null)
const currencyOf = (value: unknown): string | null => (typeof value === 'string' && CURRENCY_PATTERN.test(value) ? value.toLowerCase() : null)
// a status is echoed only if it looks like one; free text of the evidence never reaches the position
const echoStatus = (status: string | null): string | null => (status !== null && STATUS_PATTERN.test(status) ? status : null)
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

// a reference to another object: an id, an expanded object (read by its id), nothing, or something that is not an id
type Ref = { state: 'absent' } | { state: 'bad' } | { state: 'id'; id: string }
function reference(value: unknown): Ref {
  if (absent(value)) return { state: 'absent' }
  const id = plainId(isRec(value) ? value.id : value)
  return id === null ? { state: 'bad' } : { state: 'id', id }
}

// ---- what is known while the position is built -----------------------------------------------------------------------------------------------------------------------------
type Ctx = {
  found: Map<string, FundsFinding>
  // the payment's currency, id and charge id; null when they are not usable (then nothing is compared with them)
  currency: string | null
  paymentId: string | null
  chargeId: string | null
  // every balance transaction id seen so far: an id used twice by different objects is a contradiction
  movementIds: Set<string>
  feesComplete: boolean
}
function say(ctx: Ctx, code: FundsFindingCode, ref: string | null = null) {
  const { kind, detail } = TABLE[code]
  const key = `${kind}|${code}|${ref ?? ''}`
  if (!ctx.found.has(key)) ctx.found.set(key, { kind, code, ref, detail })
}
// a sum that leaves the safe integers is a contradiction, never a rounded number
function plus(ctx: Ctx, left: number, right: number): number {
  const sum = left + right
  if (Number.isSafeInteger(sum)) return sum
  say(ctx, 'invalid_amount')
  return Number.MAX_SAFE_INTEGER
}
function currencyMatches(ctx: Ctx, value: unknown, ref: string | null): boolean {
  const currency = currencyOf(value)
  if (currency === null) {
    say(ctx, 'invalid_currency', ref)
    return false
  }
  if (ctx.currency !== null && currency !== ctx.currency) {
    say(ctx, 'currency_mismatch', ref)
    return false
  }
  return true
}

// Does an object (a refund, a dispute) belong to THIS payment? By the payment it names and by the charge it names: at least one must be ours and none may be another's.
type Identity = 'ok' | 'foreign' | 'unattributable' | 'bad'
function identityOf(ctx: Ctx, record: Rec): Identity {
  if (ctx.paymentId === null) return 'ok'
  const payment = reference(record.payment_intent)
  const charge = reference(record.charge)
  if (payment.state === 'bad' || charge.state === 'bad') return 'bad'
  const foreign = (payment.state === 'id' && payment.id !== ctx.paymentId) || (charge.state === 'id' && ctx.chargeId !== null && charge.id !== ctx.chargeId)
  if (foreign) return 'foreign'
  return payment.state === 'id' || (charge.state === 'id' && ctx.chargeId !== null) ? 'ok' : 'unattributable'
}
function sayIdentity(ctx: Ctx, identity: Identity, id: string): boolean {
  if (identity === 'ok') return true
  say(ctx, identity === 'bad' ? 'invalid_identifier' : identity === 'foreign' ? 'foreign_evidence' : 'unattributable_evidence', id)
  return false
}

// ---- lists: identity of the elements, identical duplicates removed, contradictory ones refused ---------------------------------------------------------------
type Group = { id: string; record: Rec; conflicting: boolean }
function groupById(ctx: Ctx, items: ReadonlyArray<unknown>, canon: (record: Rec) => string): { groups: Group[]; rejected: number } {
  const byId = new Map<string, Rec[]>()
  let rejected = 0
  for (const item of items) {
    if (!isRec(item)) {
      say(ctx, 'invalid_evidence')
      rejected += 1
      continue
    }
    const id = plainId(item.id)
    if (id === null) {
      say(ctx, 'invalid_identifier')
      rejected += 1
      continue
    }
    byId.set(id, [...(byId.get(id) ?? []), item])
  }
  const groups: Group[] = []
  for (const id of [...byId.keys()].sort(compare)) {
    const records = byId.get(id) as Rec[]
    const first = canon(records[0])
    const same = records.every((record) => canon(record) === first)
    if (records.length > 1) say(ctx, same ? 'duplicate_removed' : 'conflicting_duplicate', id)
    groups.push({ id, record: records[0], conflicting: !same })
  }
  return { groups, rejected }
}
// the fields the model reads, as text: two descriptions of the same object are the same only if every field it reads is the same
const stable = (values: unknown[]) => JSON.stringify(values)
const refKey = (value: unknown) => (typeof value === 'string' ? value : isRec(value) && typeof value.id === 'string' ? value.id : absent(value) ? null : '?')
function canonMovement(value: unknown): string {
  if (!isRec(value)) return stable([value ?? null])
  return stable([value.id, value.amount, value.currency, value.fee, value.net, value.reporting_category, refKey(value.source)])
}
const canonRefund = (record: Rec) =>
  stable([record.id, record.amount, record.currency, record.status, refKey(record.payment_intent), refKey(record.charge), canonMovement(record.balance_transaction), canonMovement(record.failure_balance_transaction)])
const canonDispute = (record: Rec) =>
  stable([record.id, record.amount, record.currency, record.status, refKey(record.payment_intent), refKey(record.charge), Array.isArray(record.balance_transactions) ? record.balance_transactions.map(canonMovement).sort(compare) : absent(record.balance_transactions) ? null : '?'])
const readList = (value: unknown): { items: ReadonlyArray<unknown>; complete: boolean } | null => (isRec(value) && Array.isArray(value.data) ? { items: value.data, complete: value.has_more === false } : null)

// ---- a balance transaction ------------------------------------------------------------------------------------------------------------------------------------------------------
// 'unread' = an id that was not expanded; 'bad' = it contradicts itself, its owner or the payment (the finding is already said)
type Movement =
  | { kind: 'absent' }
  | { kind: 'unread' }
  | { kind: 'bad' }
  | { kind: 'ok'; id: string; amount: number; fee: number | null; category: string | null }
function readMovement(ctx: Ctx, raw: unknown, owner: string | null): Movement {
  if (absent(raw)) return { kind: 'absent' }
  if (typeof raw === 'string') {
    if (plainId(raw) === null) {
      say(ctx, 'invalid_identifier', owner)
      return { kind: 'bad' }
    }
    return { kind: 'unread' }
  }
  if (!isRec(raw)) {
    say(ctx, 'invalid_evidence', owner)
    return { kind: 'bad' }
  }
  let sound = true
  const id = plainId(raw.id)
  if (id === null) {
    say(ctx, 'invalid_identifier', owner)
    sound = false
  }
  const amount = cents(raw.amount)
  if (amount === null) {
    say(ctx, 'invalid_amount', owner)
    sound = false
  }
  // the fee is a fee: absent = unknown (the capital does not depend on it); present = a whole number, not negative
  let fee: number | null = null
  if (!absent(raw.fee)) {
    fee = cents(raw.fee)
    if (fee === null || fee < 0) {
      say(ctx, 'invalid_amount', owner)
      sound = false
      fee = null
    }
  }
  // the net is NEVER used; if it is shown it must not contradict amount - fee
  if (!absent(raw.net)) {
    const net = cents(raw.net)
    if (net === null) {
      say(ctx, 'invalid_amount', owner)
      sound = false
    } else if (amount !== null && fee !== null && net !== amount - fee) {
      say(ctx, 'balance_transaction_inconsistent', owner)
      sound = false
    }
  }
  if (!currencyMatches(ctx, raw.currency, owner)) sound = false
  const source = reference(raw.source)
  if (source.state === 'bad') {
    say(ctx, 'invalid_identifier', owner)
    sound = false
  } else if (source.state === 'id' && owner !== null && source.id !== owner) {
    say(ctx, 'foreign_evidence', owner)
    sound = false
  }
  if (id !== null) {
    if (ctx.movementIds.has(id)) {
      say(ctx, 'conflicting_duplicate', owner)
      sound = false
    } else ctx.movementIds.add(id)
  }
  if (!sound || amount === null || id === null) return { kind: 'bad' }
  return { kind: 'ok', id, amount, fee, category: typeof raw.reporting_category === 'string' ? raw.reporting_category : null }
}

// ---- one refund ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type RefundResult = { id: string; amount: number; status: string | null; outcome: RefundOutcome; fee: number; reversed: number }
function evalRefund(ctx: Ctx, group: Group): RefundResult {
  const { id, record } = group
  const status = typeof record.status === 'string' ? record.status : null
  const result: RefundResult = { id, amount: 0, status: echoStatus(status), outcome: 'excluded', fee: 0, reversed: 0 }
  if (group.conflicting) {
    ctx.feesComplete = false
    return result
  }
  let sound = sayIdentity(ctx, identityOf(ctx, record), id)
  const amount = cents(record.amount)
  if (amount === null || amount <= 0) {
    say(ctx, 'invalid_amount', id)
    sound = false
  }
  if (!currencyMatches(ctx, record.currency, id)) sound = false
  const debit = readMovement(ctx, record.balance_transaction, id)
  const reversal = readMovement(ctx, record.failure_balance_transaction, id)
  if (debit.kind === 'bad' || reversal.kind === 'bad') sound = false
  if (!sound || amount === null) {
    ctx.feesComplete = false
    return result
  }
  // the movements must match the refund: the money left (-amount), and if the refund failed it came back (+amount)
  if ((debit.kind === 'ok' && debit.amount !== -amount) || (reversal.kind === 'ok' && reversal.amount !== amount)) {
    say(ctx, 'balance_transaction_inconsistent', id)
    ctx.feesComplete = false
    return result
  }
  const counted = (outcome: RefundOutcome) => {
    result.amount = amount
    result.outcome = outcome
    for (const movement of [debit, reversal]) {
      if (movement.kind !== 'ok') continue
      if (movement.fee === null) ctx.feesComplete = false
      else result.fee = plus(ctx, result.fee, movement.fee)
    }
    return result
  }
  if (status === 'succeeded' || status === 'pending' || status === 'requires_action') {
    // a refund that has not failed has no failure movement
    if (reversal.kind !== 'absent') {
      say(ctx, 'balance_transaction_inconsistent', id)
      ctx.feesComplete = false
      return result
    }
    if (debit.kind !== 'ok') ctx.feesComplete = false
    if (status === 'succeeded') return counted('effective')
    if (status === 'requires_action') say(ctx, 'state_not_observed', id)
    say(ctx, 'refund_in_flight', id)
    return counted('in_flight')
  }
  if (status === 'failed' || status === 'canceled') {
    if (status === 'canceled') say(ctx, 'state_not_observed', id)
    if (debit.kind === 'unread' || reversal.kind === 'unread') {
      say(ctx, 'refund_movements_unreadable', id)
      ctx.feesComplete = false
      return counted('unknown')
    }
    if (debit.kind === 'ok' && reversal.kind === 'ok') {
      result.reversed = amount
      return counted('not_effective')
    }
    if (debit.kind === 'ok') {
      // the money left and nothing shows it came back
      say(ctx, 'refund_reversal_unproven', id)
      ctx.feesComplete = false
      return counted('unknown')
    }
    if (reversal.kind === 'ok') {
      // a reversal of money that did not leave
      say(ctx, 'balance_transaction_inconsistent', id)
      ctx.feesComplete = false
      return result
    }
    // no movement at all: a failed refund moved no money; a canceled one is a state never observed, so that is not enough
    if (status === 'failed') return counted('not_effective')
    say(ctx, 'refund_reversal_unproven', id)
    return counted('unknown')
  }
  // a status nobody modeled: it may be money that leaves
  say(ctx, 'refund_state_unknown', id)
  ctx.feesComplete = false
  return counted('unknown')
}

// ---- one dispute -------------------------------------------------------------------------------------------------------------------------------------------------------------------
type DisputeResult = { id: string; amount: number; status: string | null; phase: DisputePhase; withdrawn: number; reinstated: number; fee: number; worst: number; best: number }
const OPEN_DISPUTE_STATUSES: readonly string[] = ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review']
function evalDispute(ctx: Ctx, group: Group): DisputeResult {
  const { id, record } = group
  const status = typeof record.status === 'string' ? record.status : null
  const result: DisputeResult = { id, amount: 0, status: echoStatus(status), phase: 'excluded', withdrawn: 0, reinstated: 0, fee: 0, worst: 0, best: 0 }
  if (group.conflicting) {
    ctx.feesComplete = false
    return result
  }
  let sound = sayIdentity(ctx, identityOf(ctx, record), id)
  const amount = cents(record.amount)
  if (amount === null || amount <= 0) {
    say(ctx, 'invalid_amount', id)
    sound = false
  }
  if (!currencyMatches(ctx, record.currency, id)) sound = false

  // the movements: a withdrawal is a negative `dispute` movement, a reinstatement a positive `dispute_reversal` one; anything else is not guessed
  let withdrawn = 0
  let reinstated = 0
  let fee = 0
  let shown = 0
  let fullyRead = false
  const movements = record.balance_transactions
  if (!Array.isArray(movements)) {
    say(ctx, 'dispute_movements_not_read', id)
  } else {
    fullyRead = true
    const records: unknown[] = []
    for (const element of movements) {
      if (typeof element !== 'string') records.push(element)
      else if (plainId(element) === null) {
        say(ctx, 'invalid_identifier', id)
        sound = false
      } else fullyRead = false
    }
    if (!fullyRead) say(ctx, 'dispute_movements_unreadable', id)
    const grouped = groupById(ctx, records, canonMovement)
    if (grouped.rejected > 0) sound = false
    for (const entry of grouped.groups) {
      if (entry.conflicting) {
        sound = false
        continue
      }
      const movement = readMovement(ctx, entry.record, id)
      if (movement.kind !== 'ok') {
        sound = false
        continue
      }
      if (movement.category === 'dispute' && movement.amount <= 0) withdrawn = plus(ctx, withdrawn, -movement.amount)
      else if (movement.category === 'dispute_reversal' && movement.amount >= 0) reinstated = plus(ctx, reinstated, movement.amount)
      else {
        say(ctx, 'unrecognized_movement', id)
        sound = false
        continue
      }
      shown += 1
      if (movement.fee === null) ctx.feesComplete = false
      else fee = plus(ctx, fee, movement.fee)
    }
  }
  if (shown === 0 || !fullyRead) ctx.feesComplete = false
  if (reinstated > withdrawn || (status === 'lost' && reinstated > 0) || (amount !== null && amount > 0 && withdrawn > amount)) {
    say(ctx, 'dispute_amounts_inconsistent', id)
    sound = false
  }
  if (!sound || amount === null || amount <= 0) {
    ctx.feesComplete = false
    return result
  }

  // the phase, and what it leaves open: `worst` is the funds gone in the worst reading, `best` in the best one
  const phase: DisputePhase = OPEN_DISPUTE_STATUSES.includes(status ?? '') ? 'open' : status === 'won' ? 'won' : status === 'lost' ? 'lost' : 'unmodeled'
  let worst = amount
  let best = 0
  if (phase === 'open') say(ctx, 'dispute_open', id)
  else if (phase === 'unmodeled') say(ctx, 'dispute_status_not_modeled', id)
  else if (phase === 'won') {
    // "won" proves nothing about the funds: only a reinstatement as large as the withdrawal does
    if (fullyRead && withdrawn === 0) say(ctx, 'dispute_won_funds_not_shown', id)
    else if (fullyRead && reinstated < withdrawn) {
      say(ctx, 'dispute_won_funds_not_returned', id)
      worst = withdrawn - reinstated
    } else if (fullyRead) worst = 0
  } else {
    // "lost" and "closed" are not a withdrawal: only the withdrawal is
    best = withdrawn
    if (fullyRead && withdrawn === 0) say(ctx, 'dispute_lost_without_withdrawal', id)
    else if (fullyRead && withdrawn < amount) say(ctx, 'dispute_withdrawal_incomplete', id)
    else if (fullyRead) worst = withdrawn
  }
  return { id, amount, status: result.status, phase, withdrawn, reinstated, fee, worst, best }
}

// ---- the position ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const NO_MONEY_STATUSES: readonly string[] = ['requires_payment_method', 'requires_confirmation', 'requires_action']
const IN_MOTION_STATUSES: readonly string[] = ['processing', 'requires_capture']
const KIND_RANK: Record<FundsFindingKind, number> = { conflict: 0, uncertainty: 1, anomaly: 2, note: 3 }

function nothingKnown(code: FundsFindingCode): FundsPosition {
  const { kind, detail } = TABLE[code]
  return {
    currency: null, certainty: 'uncertain', final: false, collectedCents: null, retainedLowerCents: 0, retainedUpperCents: null, retainedCents: null, overRecoveredCents: 0, provisionalRefundCents: 0,
    refunds: { confirmedCents: 0, inFlightCents: 0, unknownCents: 0, requestedCents: 0, reversedCents: 0, reportedByChargeCents: null, items: [] },
    disputes: { withdrawnCents: 0, reinstatedCents: 0, fundsGoneLowerCents: 0, fundsGoneUpperCents: 0, items: [] },
    fees: { disputeCents: 0, refundCents: 0, totalCents: 0, complete: false },
    findings: [{ kind, code, ref: null, detail }],
  }
}

function readPosition(evidence: unknown): FundsPosition {
  const input: Rec = isRec(evidence) ? evidence : {}
  const intent = input.paymentIntent
  if (!isRec(intent)) return nothingKnown('payment_intent_missing')
  const ctx: Ctx = { found: new Map(), currency: null, paymentId: null, chargeId: null, movementIds: new Set(), feesComplete: true }

  // ---- the payment: what was collected ----
  ctx.paymentId = plainId(intent.id)
  if (ctx.paymentId === null) say(ctx, 'invalid_identifier')
  ctx.currency = currencyOf(intent.currency)
  if (ctx.currency === null) say(ctx, 'invalid_currency')
  const latest = reference(intent.latest_charge)
  if (latest.state === 'bad') say(ctx, 'invalid_identifier')
  // what was received: a whole number of cents that is not negative; anything else is not a figure
  const receivedCents = cents(intent.amount_received)
  const received = receivedCents !== null && receivedCents >= 0 ? receivedCents : null
  const paymentStatus = typeof intent.status === 'string' ? intent.status : null
  let collected: number | null = null
  let openEnded = false
  if (paymentStatus === 'succeeded') {
    if (received === null) say(ctx, 'invalid_amount')
    else collected = received
  } else if (paymentStatus === 'canceled' || (paymentStatus !== null && NO_MONEY_STATUSES.includes(paymentStatus))) {
    // nothing is collected; money "received" on a payment that was never paid is a contradiction, not a figure
    if (!absent(intent.amount_received) && received !== 0) say(ctx, 'invalid_amount')
    else collected = 0
    if (paymentStatus !== 'canceled') {
      say(ctx, 'payment_open')
      openEnded = true
    }
  } else if (paymentStatus !== null && IN_MOTION_STATUSES.includes(paymentStatus)) say(ctx, 'payment_in_motion')
  else say(ctx, 'payment_status_unknown')

  // ---- the charge: the total refunded and the disputed flag are cross-checks, never the evidence ----
  let reported: number | null = null
  let disputedFlag: boolean | null = null
  const chargeRaw = input.charge
  if (isRec(chargeRaw)) {
    const own = plainId(chargeRaw.id)
    if (own === null) say(ctx, 'invalid_identifier')
    ctx.chargeId = own ?? (latest.state === 'id' ? latest.id : null)
    if (ctx.paymentId !== null) {
      const names = reference(chargeRaw.payment_intent)
      if (names.state === 'bad') say(ctx, 'invalid_identifier')
      else if (names.state !== 'id' || names.id !== ctx.paymentId) say(ctx, 'charge_mismatch')
      if (own !== null && latest.state === 'id' && latest.id !== own) say(ctx, 'charge_mismatch')
    }
    currencyMatches(ctx, chargeRaw.currency, null)
    if (!absent(chargeRaw.amount_captured)) {
      const captured = cents(chargeRaw.amount_captured)
      if (captured === null || captured < 0) say(ctx, 'invalid_amount')
      else if (received !== null && captured !== received) say(ctx, 'charge_mismatch')
    }
    if (absent(chargeRaw.amount_refunded)) say(ctx, 'refund_total_not_read')
    else {
      const value = cents(chargeRaw.amount_refunded)
      if (value === null || value < 0) say(ctx, 'invalid_amount')
      else reported = value
    }
    if (typeof chargeRaw.disputed === 'boolean') disputedFlag = chargeRaw.disputed
    else say(ctx, 'dispute_state_unknown')
  } else {
    ctx.chargeId = latest.state === 'id' ? latest.id : null
    say(ctx, 'refund_total_not_read')
    say(ctx, 'dispute_state_unknown')
  }

  // ---- refunds ----
  // `refundUnknownAll`: something that could hide a refund is missing, so in the worst reading all the money may be gone
  let refundUnknownAll = reported === null
  const refundList = readList(input.refunds)
  const refundResults: RefundResult[] = []
  // the refunds Stripe lists, by id: a request that names one is judged against it
  const listedRefunds = new Map<string, RefundResult>()
  if (refundList === null) {
    say(ctx, 'refunds_not_read')
    refundUnknownAll = true
    ctx.feesComplete = false
  } else {
    if (!refundList.complete) {
      say(ctx, 'refunds_incomplete')
      refundUnknownAll = true
      ctx.feesComplete = false
    }
    for (const group of groupById(ctx, refundList.items, canonRefund).groups) {
      const result = evalRefund(ctx, group)
      listedRefunds.set(group.id, result)
      refundResults.push(result)
    }
  }
  let confirmed = 0
  let inFlight = 0
  let unknownRefunds = 0
  let reversed = 0
  let refundFees = 0
  for (const result of refundResults) {
    if (result.outcome === 'effective') confirmed = plus(ctx, confirmed, result.amount)
    else if (result.outcome === 'in_flight') inFlight = plus(ctx, inFlight, result.amount)
    else if (result.outcome === 'unknown') unknownRefunds = plus(ctx, unknownRefunds, result.amount)
    reversed = plus(ctx, reversed, result.reversed)
    refundFees = plus(ctx, refundFees, result.fee)
  }

  // ---- refunds that were asked for and that Stripe does not list ----
  // An id names ONE refund. The requests that name it must say the same (amount and currency), and so must the refund Stripe lists under it: what Stripe lists is the refund, and a request
  // that agrees with it is that refund, counted once. A request that says something else about the same id - than another request, or than the refund Stripe lists - is a contradiction:
  // never skipped for being listed, never dropped for being the second one, it is not counted, and the position is the widest interval. A request with no id is a request of its own:
  // nothing says it is the same refund as another.
  let requested = 0
  const requestedRaw = input.requestedRefunds
  if (!absent(requestedRaw)) {
    if (!Array.isArray(requestedRaw)) say(ctx, 'invalid_evidence')
    else {
      const named = new Map<string, Array<{ amount: number; currency: string | null }>>()
      for (const entry of requestedRaw) {
        if (!isRec(entry)) {
          say(ctx, 'invalid_evidence')
          continue
        }
        let sound = true
        const amount = cents(entry.amount)
        if (amount === null || amount <= 0) {
          say(ctx, 'invalid_amount')
          sound = false
        }
        let id: string | null = null
        if (!absent(entry.id)) {
          id = plainId(entry.id)
          if (id === null) {
            say(ctx, 'invalid_identifier')
            sound = false
          }
        }
        if (!absent(entry.currency) && !currencyMatches(ctx, entry.currency, id)) sound = false
        if (!sound || amount === null) continue
        if (id === null) {
          say(ctx, 'refund_requested')
          requested = plus(ctx, requested, amount)
        } else {
          // no currency written means the payment's own: a refund is always in the currency of its payment
          named.set(id, [...(named.get(id) ?? []), { amount, currency: absent(entry.currency) ? ctx.currency : currencyOf(entry.currency) }])
        }
      }
      for (const [id, descriptions] of named) {
        const first = descriptions[0]
        if (descriptions.some((other) => other.amount !== first.amount || other.currency !== first.currency)) {
          say(ctx, 'conflicting_duplicate', id)
          continue
        }
        const listed = listedRefunds.get(id)
        if (listed !== undefined) {
          // Stripe lists it: that is the refund, and the request adds nothing - unless it says another amount. A listed refund that was set aside has already said why.
          if (listed.outcome !== 'excluded' && listed.amount !== first.amount) say(ctx, 'conflicting_duplicate', id)
          continue
        }
        if (descriptions.length > 1) say(ctx, 'duplicate_removed', id)
        say(ctx, 'refund_requested', id)
        requested = plus(ctx, requested, first.amount)
      }
    }
  }

  // ---- the aggregate against the single refunds (a signal, never an addend) ----
  const explainedMost = plus(ctx, plus(ctx, plus(ctx, confirmed, inFlight), unknownRefunds), requested)
  if (reported !== null && refundList !== null && refundList.complete) {
    if (reported > explainedMost) say(ctx, 'refunded_amount_unexplained')
    if (reported < confirmed) say(ctx, 'refunded_amount_lagging')
  }
  const refundWorst = reported === null ? explainedMost : Math.max(explainedMost, reported)
  const refundBest = reported === null ? confirmed : Math.min(confirmed, reported)

  // ---- disputes ----
  let goneUnknownAll = disputedFlag === null
  const disputeList = readList(input.disputes)
  const disputeResults: DisputeResult[] = []
  if (disputeList === null) {
    say(ctx, 'disputes_not_read')
    goneUnknownAll = true
    ctx.feesComplete = false
  } else {
    if (!disputeList.complete) {
      say(ctx, 'disputes_incomplete')
      goneUnknownAll = true
      ctx.feesComplete = false
    }
    for (const group of groupById(ctx, disputeList.items, canonDispute).groups) disputeResults.push(evalDispute(ctx, group))
    // the flag of the charge is a cross-check: it never replaces a dispute and never denies one
    const attributable = disputeList.items.filter((item) => isRec(item) && identityOf(ctx, item) === 'ok').length
    if (disputedFlag === false && attributable > 0) say(ctx, 'dispute_flag_mismatch')
    if (disputedFlag === true && attributable === 0 && disputeList.complete) {
      say(ctx, 'disputed_charge_without_dispute')
      goneUnknownAll = true
    }
  }
  let withdrawn = 0
  let reinstated = 0
  let goneWorst = 0
  let goneBest = 0
  let disputeFees = 0
  for (const result of disputeResults) {
    withdrawn = plus(ctx, withdrawn, result.withdrawn)
    reinstated = plus(ctx, reinstated, result.reinstated)
    goneWorst = plus(ctx, goneWorst, result.worst)
    goneBest = plus(ctx, goneBest, result.best)
    disputeFees = plus(ctx, disputeFees, result.fee)
  }

  // ---- the interval ----
  const lossWorst = refundUnknownAll || goneUnknownAll ? collected : collected === null ? null : plus(ctx, refundWorst, goneWorst)
  const lossBest = plus(ctx, refundBest, goneBest)
  let lower = 0
  let upper: number | null = null
  let over = 0
  if (collected !== null) {
    lower = Math.max(0, collected - (lossWorst ?? collected))
    upper = openEnded ? null : Math.max(0, collected - lossBest)
    over = Math.max(0, lossBest - collected)
    if (over > 0) say(ctx, 'over_recovered')
  }
  const feesTotal = plus(ctx, disputeFees, refundFees)
  const findings = [...ctx.found.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || compare(a.code, b.code) || compare(a.ref ?? '', b.ref ?? ''))
  // evidence that contradicts itself leaves nothing to conclude: the widest interval
  if (findings.some((entry) => entry.kind === 'conflict')) {
    lower = 0
    upper = openEnded ? null : collected
  }
  const proven = !findings.some((entry) => entry.kind === 'uncertainty' || entry.kind === 'conflict')
  return {
    currency: ctx.currency,
    certainty: proven ? 'proven' : 'uncertain',
    final: proven && confirmed === 0,
    collectedCents: collected,
    retainedLowerCents: lower,
    retainedUpperCents: upper,
    retainedCents: proven && upper !== null && lower === upper ? lower : null,
    overRecoveredCents: over,
    provisionalRefundCents: confirmed,
    refunds: {
      confirmedCents: confirmed, inFlightCents: inFlight, unknownCents: unknownRefunds, requestedCents: requested, reversedCents: reversed, reportedByChargeCents: reported,
      items: refundResults.map((result) => ({ id: result.id, amountCents: result.amount, status: result.status, outcome: result.outcome, feeCents: result.fee })),
    },
    disputes: {
      withdrawnCents: withdrawn, reinstatedCents: reinstated, fundsGoneLowerCents: goneWorst, fundsGoneUpperCents: goneBest,
      items: disputeResults.map((result) => ({ id: result.id, amountCents: result.amount, status: result.status, phase: result.phase, withdrawnCents: result.withdrawn, reinstatedCents: result.reinstated, feeCents: result.fee })),
    },
    fees: { disputeCents: disputeFees, refundCents: refundFees, totalCents: feesTotal, complete: ctx.feesComplete },
    findings,
  }
}

// The one function. Evidence that cannot even be read (a getter that throws, say) is not a reliable position and not an exception: it is the widest, uncertain position.
export function computeFundsPosition(evidence: FundsEvidence): FundsPosition {
  try {
    return readPosition(evidence)
  } catch {
    return nothingKnown('invalid_evidence')
  }
}

// ---- the two questions a decision can ask --------------------------------------------------------------------------------------------------------------------------------
const wellFormed = (position: unknown): position is FundsPosition =>
  isRec(position) &&
  typeof position.retainedLowerCents === 'number' && Number.isSafeInteger(position.retainedLowerCents) && position.retainedLowerCents >= 0 &&
  (position.retainedUpperCents === null || (typeof position.retainedUpperCents === 'number' && Number.isSafeInteger(position.retainedUpperCents) && position.retainedUpperCents >= position.retainedLowerCents))

// Is at least `amountCents` held? 'yes' if even the worst reading holds it; 'no' if even the best reading does not; otherwise 'unknown'.
export function retainedAtLeast(position: FundsPosition, amountCents: number): Tri {
  if (!wellFormed(position) || typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 0) return 'unknown'
  if (position.retainedLowerCents >= amountCents) return 'yes'
  if (position.retainedUpperCents !== null && position.retainedUpperCents < amountCents) return 'no'
  return 'unknown'
}

// Is NOTHING held? Two zeroes must not be confused. A PROVEN position whose figure is zero shows zero in the SNAPSHOT; if a refund that succeeded is behind it (`final` is false) that refund can
// still fail and the money is back (AR-2 B), so it is not a zero to rely on for a decision that cannot be undone. 'yes' is given to a zero that is proven AND final (never collected; taken by
// disputes that were lost), and to nothing else: "no money held" is never concluded from an uncertain position, nor from a zero that can still change. 'no' if even the worst reading holds
// something - a refund that fails can only give money back, so that does not depend on finality. Everything else is 'unknown'.
export function retainedIsZero(position: FundsPosition): Tri {
  if (!wellFormed(position)) return 'unknown'
  if (position.certainty === 'proven' && position.retainedUpperCents === 0 && position.final === true) return 'yes'
  if (position.retainedLowerCents > 0) return 'no'
  return 'unknown'
}
