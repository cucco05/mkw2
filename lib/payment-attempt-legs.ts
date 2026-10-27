// Which payment attempts of an order can be ASKED about, and what the answers allow one to say (step 4.6, S6, P3b-1, F02). PURE: no import, no I/O, no clock, no environment, no state
// between two calls - the decision "no charge" takes its answer about the money of an order from this and from nothing else.
//
// THE DEFECT THIS CLOSES (F02). The check of "no charge" (lib/payment-hold.ts) asked Stripe about the payment attempts that have a Stripe session id or payment intent id and SKIPPED
// the others; when nothing it had asked showed money it answered "no money", and the decision recorded `confirmed_no_charge` - a confirmation nobody had asked Stripe for. An attempt that
// carries no identifier is not evidence that nothing was charged: nothing can be asked about it (a session may have been created at Stripe while the answer was lost; a reservation may
// have been closed while its request was still on the way). It is NOT VERIFIABLE.
//
// THE RULES (all of them fail closed)
//   * An attempt is READABLE only if it carries a well-formed Stripe identifier: a checkout session id (`cs_...`) and/or a payment intent id (`pi_...`), the shapes the application itself
//     accepts for Stripe identifiers (lib/stripe-webhook.ts). An identifier that is absent (null, undefined, empty), blank, malformed, or not a string is not one. Junk next to a good
//     identifier makes the whole attempt not readable: it is never "repaired" into a channel that is read through the other field.
//   * An attempt without an id of its own cannot be told apart from another: not readable. The same attempt id described in two different ways is a contradiction: none of its
//     descriptions is a verified channel. (The same description twice is just a repeat.)
//   * There is NO exception: not for an expired reservation, not for a failure with a reason, not for an attempt that expired long ago. Whether any of these may one day be trusted, and with
//     what margin, is a decision of the owner (docs/VERIFICA-4.6.md, S6a.23), not of this module.
//   * Combining what was asked: money on any channel wins (the answer is "money", whatever else is unknown); otherwise a channel with no identifier, a read that failed, or a readable
//     channel with NO outcome makes the answer "unknown"; only when every channel was asked and none showed money is it "none".
//   * Data that is not what the contract says never produces a favorable answer: a list that is not a list leaves a placeholder that cannot be verified, a row that is not an object takes
//     its place as an attempt that cannot be verified, a getter that throws is data that cannot be read, an outcome that is not one of the three is not "no money".
//
// THE SET OF ATTEMPTS. The attempts that were examined are kept as an immutable copy (`snapshotAttempts`) and, under the lock of the order, compared with the attempts found there
// (`attemptSetsMatch`): by id, by Stripe identifiers and by status - not by the number of rows. A change of any of them means that what was read may no longer cover the order. This is
// OUR lock: it says nothing about what happens at Stripe after the last read.

// ---- the attempts -----------------------------------------------------------------------------------------------------------------------------------------------------------
// What the examination looks at. Other columns of a payment attempt are ignored.
export type HoldAttemptFacts = {
  id: string
  stripeSessionId: string | null
  stripePaymentIntentId: string | null
}

// A leg is one payment attempt seen as a channel through which money may have reached the order.
//   stripe_readable      - it carries a well-formed Stripe identifier: Stripe can be asked about it
//   no_stripe_identifier - it does not (absent, blank, malformed, not a string, no id of its own, or contradicted): nothing can be asked about it
export const ATTEMPT_LEG_BASES = Object.freeze(['stripe_readable', 'no_stripe_identifier'] as const)
export type AttemptLegBasis = (typeof ATTEMPT_LEG_BASES)[number]
export type AttemptLeg = { attemptId: string; basis: AttemptLegBasis }

// The shapes the application accepts for Stripe identifiers (lib/stripe-webhook.ts): a prefix, then letters, digits or underscores. No flag: a regular expression with `g` or `y` keeps state.
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,255}$/
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,255}$/
// What a value that is neither a string nor absent becomes: PRESENT, and never valid. (Turning it into "absent" would let junk next to a good identifier pass as a readable channel.)
const NOT_AN_IDENTIFIER = '<not an identifier>'
const UNREADABLE = Symbol('unreadable')

type Row = { id: string; session: string | null; intent: string | null; status: string | null }
const UNVERIFIABLE_ROW: Row = Object.freeze({ id: '', session: NOT_AN_IDENTIFIER, intent: NOT_AN_IDENTIFIER, status: null })

function readProperty(row: object, key: string): unknown {
  try {
    return (row as Record<string, unknown>)[key]
  } catch {
    return UNREADABLE
  }
}
// absent (null, undefined, empty) -> null; a string -> itself; anything else (also a getter that threw) -> present and never valid
function identifierOf(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'string' ? value : NOT_AN_IDENTIFIER
}
function rowOf(entry: unknown): Row {
  try {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return UNVERIFIABLE_ROW
    const id = readProperty(entry, 'id')
    const status = readProperty(entry, 'status')
    return {
      id: typeof id === 'string' ? id : '',
      session: identifierOf(readProperty(entry, 'stripeSessionId')),
      intent: identifierOf(readProperty(entry, 'stripePaymentIntentId')),
      status: typeof status === 'string' ? status : null,
    }
  } catch {
    return UNVERIFIABLE_ROW
  }
}
// null when the container can not be read as a list
function rowsOf(list: unknown): Row[] | null {
  try {
    if (!Array.isArray(list)) return null
    const rows: Row[] = []
    for (let index = 0; index < list.length; index++) rows.push(rowOf(list[index]))
    return rows
  } catch {
    return null
  }
}

function basisOf(row: Row): AttemptLegBasis {
  if (row.id === '') return 'no_stripe_identifier'
  const badSession = row.session !== null && !SESSION_ID.test(row.session)
  const badIntent = row.intent !== null && !PAYMENT_INTENT_ID.test(row.intent)
  if (badSession || badIntent) return 'no_stripe_identifier'
  return row.session !== null || row.intent !== null ? 'stripe_readable' : 'no_stripe_identifier'
}
// the attempt ids that are described in two different ways
function contradictedIds(rows: ReadonlyArray<Row>): Set<string> {
  const first = new Map<string, Row>()
  const contradicted = new Set<string>()
  for (const row of rows) {
    if (row.id === '') continue
    const seen = first.get(row.id)
    if (seen === undefined) first.set(row.id, row)
    else if (seen.session !== row.session || seen.intent !== row.intent || seen.status !== row.status) contradicted.add(row.id)
  }
  return contradicted
}

// One leg per attempt, in the order given. A container that is not a list leaves ONE leg that can not be verified (never an empty list: "no attempts" would read as "nothing to ask").
export function classifyAttemptLegs(attempts: ReadonlyArray<HoldAttemptFacts>): AttemptLeg[] {
  const rows = rowsOf(attempts)
  if (rows === null) return [{ attemptId: '', basis: 'no_stripe_identifier' }]
  const contradicted = contradictedIds(rows)
  return rows.map((row): AttemptLeg => ({ attemptId: row.id, basis: contradicted.has(row.id) ? 'no_stripe_identifier' : basisOf(row) }))
}

// ---- what was asked, and what it allows one to say ------------------------------------------------------------------------------------------------------------------------
// The outcome of asking Stripe about ONE readable channel. `unreadable`: Stripe could not be asked, or did not answer.
export type LegRead = 'money' | 'no_money' | 'unreadable'
export type CombinedChargeEvidence = {
  verdict: 'money' | 'none' | 'unknown'
  withoutIdentifier: number   // legs that could not be asked about (also: contradicted legs)
  unreadable: number          // readable legs whose answer is missing, failed or is not one of the three
}

function legsOf(legs: unknown): AttemptLeg[] | null {
  try {
    if (!Array.isArray(legs)) return null
    const out: AttemptLeg[] = []
    for (let index = 0; index < legs.length; index++) out.push(legOf(legs[index]))
    return out
  } catch {
    return null
  }
}
function legOf(leg: unknown): AttemptLeg {
  try {
    if (leg === null || typeof leg !== 'object') return { attemptId: '', basis: 'no_stripe_identifier' }
    const attemptId = (leg as { attemptId?: unknown }).attemptId
    const basis = (leg as { basis?: unknown }).basis
    if (typeof attemptId !== 'string' || attemptId === '') return { attemptId: '', basis: 'no_stripe_identifier' }
    return { attemptId, basis: basis === 'stripe_readable' ? 'stripe_readable' : 'no_stripe_identifier' }
  } catch {
    return { attemptId: '', basis: 'no_stripe_identifier' }
  }
}
function outcomeOf(outcomes: unknown, attemptId: string): LegRead | undefined {
  try {
    if (outcomes === null || typeof outcomes !== 'object' || typeof (outcomes as { get?: unknown }).get !== 'function') return undefined
    const value = (outcomes as { get: (key: string) => unknown }).get(attemptId)
    return value === 'money' || value === 'no_money' || value === 'unreadable' ? value : undefined
  } catch {
    return undefined
  }
}

// Money found on any channel is "money"; a channel that could not be asked about, a read that failed, or a readable channel with no outcome makes the rest "unknown"; "none" only when
// every channel was asked and none showed money. (No legs at all is vacuously "none": the payment hold refuses an order with no attempts before it asks anything.)
export function combineLegEvidence(legs: ReadonlyArray<AttemptLeg>, reads: ReadonlyMap<string, LegRead>): CombinedChargeEvidence {
  const entries = legsOf(legs)
  if (entries === null) return { verdict: 'unknown', withoutIdentifier: 0, unreadable: 0 }
  const bases = new Map<string, AttemptLegBasis>()
  const contradicted = new Set<string>()
  for (const entry of entries) {
    if (entry.attemptId === '') continue
    const seen = bases.get(entry.attemptId)
    if (seen === undefined) bases.set(entry.attemptId, entry.basis)
    else if (seen !== entry.basis) contradicted.add(entry.attemptId)
  }
  let money = false
  let withoutIdentifier = 0
  let unreadable = 0
  for (const entry of entries) {
    const outcome = outcomeOf(reads, entry.attemptId)
    if (outcome === 'money') money = true
    if (entry.basis === 'no_stripe_identifier' || contradicted.has(entry.attemptId)) {
      withoutIdentifier += 1
      continue
    }
    if (outcome !== 'no_money' && outcome !== 'money') unreadable += 1
  }
  return { verdict: money ? 'money' : withoutIdentifier > 0 || unreadable > 0 ? 'unknown' : 'none', withoutIdentifier, unreadable }
}

// ---- the set of attempts that was examined ----------------------------------------------------------------------------------------------------------------------------------
// An immutable copy of what the examination looked at: nothing is shared with the rows it was made from, and a later change of the rows does not reach it.
export type VerifiedAttempt = {
  readonly id: string
  readonly stripeSessionId: string | null
  readonly stripePaymentIntentId: string | null
  readonly status: string | null
}
export function snapshotAttempts(attempts: ReadonlyArray<HoldAttemptFacts & { status?: string | null }>): ReadonlyArray<VerifiedAttempt> {
  const rows = rowsOf(attempts) ?? [UNVERIFIABLE_ROW]
  return Object.freeze(rows.map((row): VerifiedAttempt => Object.freeze({ id: row.id, stripeSessionId: row.session, stripePaymentIntentId: row.intent, status: row.status })))
}

// null when the list can not be compared: not a list, a row with no id of its own, an id twice
function canonicalSet(list: unknown): string[] | null {
  const rows = rowsOf(list)
  if (rows === null) return null
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.id === '' || ids.has(row.id)) return null
    ids.add(row.id)
  }
  return rows.map((row) => JSON.stringify([row.id, row.session, row.intent, row.status])).sort()
}
// Is the set found now the set that was examined? Same attempts (by id), same Stripe identifiers, same status; the order of the rows and every other column do not count. Anything that
// can not be compared is "no".
export function attemptSetsMatch(verified: ReadonlyArray<VerifiedAttempt>, current: ReadonlyArray<HoldAttemptFacts & { status?: string | null }>): boolean {
  const earlier = canonicalSet(verified)
  const later = canonicalSet(current)
  if (earlier === null || later === null || earlier.length !== later.length) return false
  return earlier.every((entry, index) => entry === later[index])
}
