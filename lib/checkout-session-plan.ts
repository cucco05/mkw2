// What may be done about the payment page of an order, decided from facts alone (DR-13). PURE: no import that reads anything, no I/O, no clock but the `now` it is given, no state between two
// calls - the decision "a new page may be opened" takes its answer from this and from nothing else, which is what lets it be tested over every combination of attempts.
//
// THE RULE (docs: DR-13 plan, REVISIONE 1): ONE payable page per order. A page is replaced only after the provider has PROVED the old one closed; a reservation whose outcome is not
// known is resolved, never closed by the clock; anything that cannot be proved leaves the order exactly as it is and says so (`unresolved`). A new page is opened (`create`) in ONE case:
// nothing of the order is alive, nothing is in doubt, nothing is being paid.
//
//   blocked      the order (or a payment of it) forbids a new page: paid, being confirmed, cancelled, not awaiting payment, under review, a payment that did not match
//   too_many     the order has used its attempts
//   unresolved   something about the order cannot be proved (an attempt of a status nobody knows, a live attempt with no Stripe identifier, a closed attempt that was never proved closed):
//                nothing is opened and nothing is closed - a person looks
//   reuse        ONE page is alive and has time left: ask the provider, and hand it out if it is still open
//   prove        a CLOSED attempt that has a Stripe identifier but no proof of closing (the identifier names the page to ask about; it does not show that the page is closed): ask the provider,
//                close the page there if it is open, and write the proof on the row - before anything else is decided
//   retire       page(s) that must not be handed out (no time left, or twins): close them AT THE PROVIDER, with proof, before anything else
//   replay       a reservation (`creating`) exists, of ANY age: send its own request again (same key, same parameters) to learn what it made - or, where that is not provably safe, say it is unresolved
//   create       reserve a new attempt
//
// "A closed attempt that was never proved closed" (mandate B): an attempt closed `expired` / `failed` that has no Stripe identifier and no proof that nothing was ever sent - the old code closed
// a reservation by the clock (`stale_reservation`) or after a Stripe error, and a page may exist at the provider that the database never learned about. Such a row is NOT safe because it is
// old: while one exists no new page is opened. (It is never altered or deleted.)
//
// "A closed attempt WITH an identifier" (follow-up P0-B): the identifier is not a proof either. A row is closed by whoever writes it - a payment event that touches the attempt and not the
// page, an administrator's decision, the old code's clock, a request that lost a race - while the page at the provider goes on being payable. What shows that a page is closed is the
// provider's own word, written on the row when it was given: `closed_by_us:` (we expired it and the provider confirmed) or `provider_status:expired` (the session reads back expired). A closed
// row with an identifier and neither of these is asked about (`prove`) before anything is opened next to it.
// `session_mismatch:<problem>` is NOT such a word: it names a CAUSE. The code that was published wrote it for an OPEN page that no longer matched the order, closed the row, and never asked the
// provider to close the page (lib/checkout-sessions.ts at 457df91, reopenAttempt): the page stayed payable. A reason is a proof only if it STARTS with a proof; the new code, when it really
// closes a page that does not match, writes the proof first and the cause after it (`mismatchClosureReason`).
import { isPaymentVerified } from '@/lib/order-payment-policy'

// ---- the numbers (one place; lib/checkout-sessions.ts re-exports the ones it always had) ---------------------------------------------------------------------------------------------------
// Stripe needs a session to live at least 30 minutes; the extra 2 minutes cover the time between reserving and calling.
export const SESSION_TTL_MS = 32 * 60 * 1000
// The old "a reservation that is still young may belong to a request in flight": kept as the name of the window in which a replay is a request that can still be made new (see replayMode).
export const JOIN_WINDOW_MS = 90 * 1000
// A session that is about to expire is not handed out again.
export const REUSE_MARGIN_MS = 60 * 1000
export const MAX_ATTEMPTS_PER_ORDER = 5
// The provider accepts `expires_at` between 30 minutes and 24 hours after creation (https://docs.stripe.com/api/checkout/sessions/create).
export const PROVIDER_MIN_EXPIRY_MS = 30 * 60 * 1000
// ... and a request to create must have this much more than the minimum left: the call takes time and clocks differ.
export const FRESH_SAFETY_MS = 30 * 1000
// The provider keeps an idempotency key for AT LEAST 24 hours and may remove it after (https://docs.stripe.com/api/idempotent_requests); replays are not sent from this age on, whatever else is true.
export const REPLAY_RETENTION_MS = 23 * 60 * 60 * 1000
// A reservation "from the future" (a clock that is far off) is not trusted to have an age at all.
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

// ---- the vocabulary of why an attempt was closed (failureReason) --------------------------------------------------------------------------------------------------------------------------
// What PROVES that no page was ever created for an attempt (and so lets a closed row without an identifier be safe): the request was never sent, or the provider rejected it in a way that was
// shown (Test Mode, accepted by the owner) to create nothing. Nothing the old code wrote has these prefixes.
export const PROVEN_NOT_CREATED_PREFIXES: readonly string[] = ['local_refusal:', 'provider_rejected:']
export const REASON_LOCAL_REFUSAL = 'local_refusal:'
export const REASON_PROVIDER_REJECTED = 'provider_rejected:'
export const REASON_PROVIDER_EXPIRED = 'provider_status:expired'
export const REASON_CLOSED_BY_US = 'closed_by_us:'
export const REASON_STALE_RESERVATION = 'stale_reservation' // written by the OLD code only; the new code never writes it
export const REASON_SESSION_MISMATCH = 'session_mismatch:'
// The shape of a Checkout session id (the one the webhook accepts, and the payment hold's examination of the attempts - F02 - reads the same way): an identifier that does not have it can not be asked about, so it is no identifier at all.
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,255}$/
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}
// What a row says when the PROVIDER has shown its page closed. Nothing else is a proof of closing - not a status, not an identifier, not the time that has passed, and not a reason that only
// names a cause (`session_mismatch:`, `payment_failed`, `admin_released`, `stale_reservation`...): the old code wrote those for rows whose page it had not closed.
export const PROOF_OF_CLOSING_PREFIXES: readonly string[] = [REASON_CLOSED_BY_US, REASON_PROVIDER_EXPIRED]
export function closingIsProved(reason: string | null | undefined): boolean {
  const text = reason ?? ''
  return PROOF_OF_CLOSING_PREFIXES.some((prefix) => text.startsWith(prefix))
}
// The reason of a page that did not match the order and was closed WITH the provider's proof (`by`: who closed it, as closeAtProvider reports it): the proof first - that is what is looked for - and
// the cause after it, so that nothing about the mismatch is lost.
export function mismatchClosureReason(by: 'us' | 'provider', problem: string): string {
  return (by === 'us' ? `${REASON_CLOSED_BY_US}${REASON_SESSION_MISMATCH}${problem}` : `${REASON_PROVIDER_EXPIRED} (${REASON_SESSION_MISMATCH}${problem})`).slice(0, 200)
}
// The reason a closed row gets when the provider shows its page closed: the proof first (that is what is looked for), what the row said before after it (nothing is lost).
export function stampProof(proof: string, previous: string | null | undefined): string {
  const was = previous && !closingIsProved(previous) ? ` (was ${previous})` : ''
  return `${proof}${was}`.slice(0, 200)
}

// ---- facts -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type When = Date | number | string | null | undefined
export type PlanOrder = {
  status: string
  paymentStatus: string
  paymentReviewReason: string | null
  paidAt?: When
  stripePaymentIntentId?: string | null
}
export type PlanAttempt = {
  id: string
  status: string
  stripeSessionId: string | null
  failureReason?: string | null
  amountReceivedCents?: number | null
  createdAt: When
  expiresAt: When
}
export type BlockReason = 'paid' | 'processing' | 'cancelled' | 'not_payable' | 'review'
export type UnresolvedWhy = 'unknown_attempt_status' | 'open_without_session' | 'uncertain_history'
export type ReplayMode = 'FRESH_OK' | 'EVIDENCE_ONLY' | 'NO_REPLAY'

export type Plan =
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'too_many_attempts' }
  | { kind: 'unresolved'; why: UnresolvedWhy }
  | { kind: 'reuse'; attemptId: string }
  | { kind: 'prove'; attemptIds: string[] }
  | { kind: 'retire'; attemptIds: string[] }
  | { kind: 'replay'; attemptId: string }
  | { kind: 'create' }

export const KNOWN_ATTEMPT_STATUSES: readonly string[] = ['creating', 'open', 'processing', 'paid', 'expired', 'failed', 'mismatch']

export function toMs(value: When): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Date.parse(value)
  return Number.NaN
}

// ---- the closed attempt whose closing was never proved -----------------------------------------------------------------------------------------------------------------------------
// Closed (`expired` / `failed`) and either closed by the CLOCK (`stale_reservation`, with or without an identifier: whatever happened afterwards to its page is not shown by the row) or
// without any Stripe identifier and without the proof that nothing was ever created.
export function closedWithoutProof(attempt: Pick<PlanAttempt, 'status' | 'stripeSessionId' | 'failureReason'>): boolean {
  if (attempt.status !== 'expired' && attempt.status !== 'failed') return false
  const reason = attempt.failureReason ?? ''
  if (reason === REASON_STALE_RESERVATION) return true
  // with an identifier that can be asked about: only the provider's word shows that the page is closed (the identifier says which page to ask about)
  if (isSessionId(attempt.stripeSessionId)) return !closingIsProved(reason)
  // (no identifier - or one that is not shaped like a session id, which can not be asked about: the same)
  return !PROVEN_NOT_CREATED_PREFIXES.some((prefix) => reason.startsWith(prefix))
}

// A closed attempt whose page can be ASKED ABOUT (it has an identifier) and has not been shown closed: the case `prove` is for. (Without an identifier nothing can be asked: that row is "in
// doubt" - closedWithoutProof - and stays so.)
export function closedWithIdUnproven(attempt: Pick<PlanAttempt, 'status' | 'stripeSessionId' | 'failureReason'>): boolean {
  return (attempt.status === 'expired' || attempt.status === 'failed') && isSessionId(attempt.stripeSessionId) && !closingIsProved(attempt.failureReason)
}

// a financial fact that does not fit "a page may be opened": money seems to have arrived while the order does not say it is paid
function incompatibleMoneyProof(order: PlanOrder, attempts: ReadonlyArray<PlanAttempt>): boolean {
  if (order.paidAt) return true
  if (order.stripePaymentIntentId) return true
  return attempts.some((attempt) => typeof attempt.amountReceivedCents === 'number' && attempt.amountReceivedCents > 0)
}

// ---- the decision ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function planNextStep(input: { order: PlanOrder; attempts: ReadonlyArray<PlanAttempt>; now: number }): Plan {
  const { order, attempts, now } = input
  // 1. the order
  if (isPaymentVerified(order.paymentStatus)) return { kind: 'blocked', reason: 'paid' }
  if (order.paymentStatus === 'processing') return { kind: 'blocked', reason: 'processing' }
  if (order.status === 'cancelled') return { kind: 'blocked', reason: 'cancelled' }
  if (order.status !== 'awaiting_payment') return { kind: 'blocked', reason: 'not_payable' }
  // A payment that did not match is waiting for a person: no new payment page until it is cleared.
  if (order.paymentReviewReason) return { kind: 'blocked', reason: 'review' }
  if (incompatibleMoneyProof(order, attempts)) return { kind: 'blocked', reason: 'review' }

  // 2. a payment of the order
  if (attempts.some((attempt) => attempt.status === 'paid')) return { kind: 'blocked', reason: 'paid' }
  if (attempts.some((attempt) => attempt.status === 'processing')) return { kind: 'blocked', reason: 'processing' }
  if (attempts.some((attempt) => attempt.status === 'mismatch')) return { kind: 'blocked', reason: 'review' }
  if (attempts.some((attempt) => !KNOWN_ATTEMPT_STATUSES.includes(attempt.status))) return { kind: 'unresolved', why: 'unknown_attempt_status' }

  // 2b. a closed attempt whose page was never shown closed: asked about, and closed at the provider if it is open, BEFORE anything else is decided - a reservation replayed, a page handed out or a
  // page reserved next to a page that may be payable would be a second payable page. (The ones without an identifier are in doubt below, as before.)
  const toProve = attempts.filter(closedWithIdUnproven)
    .sort((a, b) => (toMs(a.createdAt) - toMs(b.createdAt)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))   // (the oldest first, ties by id: the same for everybody)
  if (toProve.length > 0) return { kind: 'prove', attemptIds: toProve.map((attempt) => attempt.id) }

  // 3. a reservation is resolved, whatever its age: the oldest first (ties by id, so that the choice is the same for everybody)
  const reservations = attempts.filter((attempt) => attempt.status === 'creating')
    .sort((a, b) => (toMs(a.createdAt) - toMs(b.createdAt)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (reservations.length > 0) return { kind: 'replay', attemptId: reservations[0].id }

  const uncertain = attempts.some(closedWithoutProof)
  const open = attempts.filter((attempt) => attempt.status === 'open')

  // 4. pages that are alive
  if (open.length > 0) {
    // A page with no Stripe identifier cannot be asked about, nor closed: nothing can be proved about it.
    if (open.some((attempt) => !attempt.stripeSessionId)) return { kind: 'unresolved', why: 'open_without_session' }
    const left = (attempt: PlanAttempt) => toMs(attempt.expiresAt) - now
    const best = (candidates: PlanAttempt[]) => [...candidates].sort((a, b) => (toMs(b.expiresAt) - toMs(a.expiresAt)) || (toMs(b.createdAt) - toMs(a.createdAt)) || (a.id < b.id ? -1 : 1))[0]
    const usable = open.filter((attempt) => left(attempt) > REUSE_MARGIN_MS)
    if (uncertain) {
      // Nothing can replace a page here (a new one is not opened while something is in doubt), so a page is never closed to make room for one: the best page that still has time is
      // handed out again, however little; twins are closed; only a page with no time at all goes (and the order then waits for a person).
      const alive = open.filter((attempt) => left(attempt) > 0)
      if (alive.length === 0) return { kind: 'retire', attemptIds: open.map((attempt) => attempt.id) }
      const keeper = best(alive)
      const extras = open.filter((attempt) => attempt.id !== keeper.id)
      return extras.length > 0 ? { kind: 'retire', attemptIds: extras.map((attempt) => attempt.id) } : { kind: 'reuse', attemptId: keeper.id }
    }
    if (usable.length === 0) return { kind: 'retire', attemptIds: open.map((attempt) => attempt.id) }
    const keeper = best(usable)
    const extras = open.filter((attempt) => attempt.id !== keeper.id)
    return extras.length > 0 ? { kind: 'retire', attemptIds: extras.map((attempt) => attempt.id) } : { kind: 'reuse', attemptId: keeper.id }
  }

  // 5. nothing is alive
  if (uncertain) return { kind: 'unresolved', why: 'uncertain_history' }
  if (attempts.length >= MAX_ATTEMPTS_PER_ORDER) return { kind: 'too_many_attempts' }
  return { kind: 'create' }
}

// ---- replaying a reservation -------------------------------------------------------------------------------------------------------------------------------------------------------------
// A reservation's own request (same key, same parameters) can be sent again, but what the provider does with it depends on time:
//   FRESH_OK       the request is still a valid NEW request (its `expires_at` is still more than 30 minutes away, with a margin): if the first one never arrived the provider creates the page now,
//                  if it did arrive it returns what it made. Either way there is at most one page for this key.
//   EVIDENCE_ONLY  a NEW request with these parameters would be refused (`expires_at` too near): the replay can only bring back what the first call saved. It is sent to LEARN, never to create.
//   NO_REPLAY      23 hours or more after the reservation (the provider may have forgotten the key, and a replay would be a different request), or the age cannot be read: nothing is sent.
// Whatever mode, a replay whose answer is not a session leaves the reservation exactly as it was.
export function replayMode(attempt: Pick<PlanAttempt, 'createdAt' | 'expiresAt'>, now: number): ReplayMode {
  const created = toMs(attempt.createdAt)
  const expires = toMs(attempt.expiresAt)
  if (!Number.isFinite(created) || !Number.isFinite(expires) || !Number.isFinite(now)) return 'NO_REPLAY'
  if (created - now > MAX_FUTURE_SKEW_MS) return 'NO_REPLAY'
  if (now - created >= REPLAY_RETENTION_MS) return 'NO_REPLAY'
  if (expires - now >= PROVIDER_MIN_EXPIRY_MS + FRESH_SAFETY_MS) return 'FRESH_OK'
  return 'EVIDENCE_ONLY'
}

// ---- how often a reservation's request may be sent again ---------------------------------------------------------------------------------------------------------------------------
// A replay in EVIDENCE_ONLY mode can only bring back what the first call saved: it is a question, not a request, and asking it again and again is pointless (and, to a provider that answers
// with a saved error, noise). It is paced PER ORDER, in the database (the fixed-window counter the other limiters of the checkout use), so that the pace holds across requests AND across
// processes - not per process, and not per click: ONE send per window, however often Pay is pressed.
// Not paced, on purpose: a replay in FRESH_OK mode (the request is still a NEW one for the provider; duplicates collapse onto one session by the key; it is the normal path of a double click,
// several tabs or a retry after a lost answer - throttling it would turn a legitimate burst into a refusal for no gain in safety; the session endpoint's own limits bound its rate), and asking about a
// session whose identifier is already KNOWN (retrieve: not sending anything).
export const EVIDENCE_REPLAY_PACE = { windowMs: 30 * 1000, max: 1 } as const
export const REPLAY_PACE_KEY_PREFIX = 'checkout:replay:'
export const evidenceReplayKey = (orderId: string) => `${REPLAY_PACE_KEY_PREFIX}evidence:order:${orderId}`

// ---- what an error of the provider shows -------------------------------------------------------------------------------------------------------------------------------------------
// A call to `create` that did not give a session says NOTHING about whether one was made, except in the two cases below. Everything else - a lost connection, a timeout, a 409 or a 429, a 5xx
// (which the provider SAVES for the key and returns again), a 400 of any kind (a generic `invalid_request_error` is also what an idempotency conflict or a refused expiry looks like),
// a 401/403, an error nobody understands - is AMBIGUOUS.
//   never_sent        the request was refused HERE, before any call (the order's lines do not add up, ...): it is shown by the code itself that nothing reached the provider
//   proven_not_created  the error is on a list of errors the owner has seen create nothing (Test Mode). The list is EMPTY: nothing is proved yet.
//   ambiguous         everything else; `transient` says whether the same call is worth repeating soon (the network, a timeout, 429, 409, 5xx), which only changes the words and the HTTP status
export type StripeErrorLike = { name?: unknown; type?: unknown; rawType?: unknown; code?: unknown; statusCode?: unknown; param?: unknown }
export type ProvenSignature = { type?: string; rawType?: string; code?: string; statusCode?: number; param?: string }
export const PROVEN_NOT_CREATED: ReadonlyArray<ProvenSignature> = Object.freeze([])
export const LOCAL_REFUSAL_NAME = 'LocalRefusalError'
export type CreateErrorClass = { class: 'never_sent' | 'proven_not_created' | 'ambiguous'; transient: boolean }

const str = (value: unknown) => (typeof value === 'string' ? value : '')
export function classifyCreateError(error: unknown, proven: ReadonlyArray<ProvenSignature> = PROVEN_NOT_CREATED): CreateErrorClass {
  const e = (error && typeof error === 'object' ? error : {}) as StripeErrorLike
  if (e.name === LOCAL_REFUSAL_NAME) return { class: 'never_sent', transient: false }
  const type = str(e.type)
  const rawType = str(e.rawType)
  const code = str(e.code)
  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined
  if (proven.some((signature) =>
    (signature.type === undefined || signature.type === type) && (signature.rawType === undefined || signature.rawType === rawType)
    && (signature.code === undefined || signature.code === code) && (signature.statusCode === undefined || signature.statusCode === status)
    && (signature.param === undefined || signature.param === str(e.param)))) return { class: 'proven_not_created', transient: false }
  const transient = type === 'StripeConnectionError' || type === 'StripeAPIError' || type === 'StripeRateLimitError'
    || rawType === 'api_error' || rawType === 'rate_limit_error' || code === 'idempotency_key_in_use' || code === 'lock_timeout'
    || status === 409 || status === 429 || (status !== undefined && status >= 500) || (type === '' && rawType === '' && status === undefined && code === '')
  return { class: 'ambiguous', transient }
}

// ---- what the provider says about a session it was asked to close, or asked about -----------------------------------------------------------------------------------------------------
//   closed     the session is `expired`: it can no longer be paid
//   complete   the customer finished paying: money may be on its way (NOT the same as expired or failed)
//   open       still payable
//   unknown    anything else, and an answer that could not be read: nothing is concluded
export type SessionState = 'closed' | 'complete' | 'open' | 'unknown'
export function classifySessionStatus(status: unknown): SessionState {
  if (status === 'expired') return 'closed'
  if (status === 'complete') return 'complete'
  if (status === 'open') return 'open'
  return 'unknown'
}
// After an attempt to close a session ("expire"), only these count as proof: the answer said `expired`, or the session read back as `expired` / `complete`. A session read back as `open`
// after a refused or failed `expire` was not closed: unknown.
export function classifyCloseOutcome(status: unknown): Exclude<SessionState, 'open'> {
  const state = classifySessionStatus(status)
  return state === 'open' ? 'unknown' : state
}
