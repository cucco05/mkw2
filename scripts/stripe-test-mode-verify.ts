// Verification of the Stripe facts the S6 design rests on - in Stripe TEST MODE, run BY THE OWNER (step 4.6, S6, P0). Guide: docs/STRIPE-TEST-MODE-S6.md.
//
//   npx tsx scripts/stripe-test-mode-verify.ts --dry-run                              (lists what would happen; opens no connection; needs no key)
//   npx tsx scripts/stripe-test-mode-verify.ts --report-dir "$HOME/stripe-verify"     (the real run: asks for a "YES" first)
//
// What it guarantees, and what tests/stripe-test-mode-verify.test.ts proves OFFLINE (with a fake Stripe: no network, no key):
//   * the key is read ONLY from the variable STRIPE_SECRET_KEY of the shell, never from a file (no `.env` is read), and only a TEST key is accepted (sk_test_ / rk_test_);
//   * every answer is checked: a live-mode object stops the run on the spot;
//   * a declared MAXIMUM of objects, amounts, calls and time (BUDGET): the run stops before it would go over; there is no automatic retry (maxNetworkRetries: 0);
//   * every object it creates carries metadata.makerworksVerify=<run id>; it cleans up ONLY what the API allows (a succeeded payment, a refund, a dispute can not be deleted) and
//     the report says, for every object, what was observed (deleted | canceled | expired | voided | detached | remains);
//   * it never prints or stores a key, a client secret, a receipt link, an e-mail address or card data: the report is checked for them before it is written (mode 0600, in a
//     folder OUTSIDE the repository that you choose). The only thing to send back is that report.
// This file contacts Stripe ONLY when you run it for real. Nothing in this repository runs it.
import Stripe from 'stripe'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { randomBytes, randomUUID } from 'node:crypto'

// =====================================================================================================================================================================
// The declared maxima
// =====================================================================================================================================================================
export const BUDGET = {
  // money: Stripe's test mode moves no real money; the amounts are kept small all the same
  maxAmountCentsPerPayment: 100,
  maxAmountCentsTotal: 500,
  // objects that may be created (the guided payment of T2 counts as a Checkout Session and a PaymentIntent)
  checkoutSessions: 2,
  paymentIntents: 5,
  refunds: 12,
  disputeEvidenceSubmissions: 2,
  webhookEndpoints: 1,
  // never created
  customers: 0, products: 0, prices: 0, invoices: 0, paymentLinks: 0,
  // calls and time
  maxApiCalls: 170,
  maxRunMs: 20 * 60_000,
  perCallTimeoutMs: 20_000,
  maxPollAttempts: 8,
  pollIntervalMs: 5_000,
  searchWindowMs: 90_000,
  searchIntervalMs: 10_000,
} as const

export type ObjectKind = 'checkout_session' | 'payment_intent' | 'refund' | 'dispute_evidence' | 'webhook_endpoint'
const KIND_LIMIT: Record<ObjectKind, number> = {
  checkout_session: BUDGET.checkoutSessions, payment_intent: BUDGET.paymentIntents, refund: BUDGET.refunds, dispute_evidence: BUDGET.disputeEvidenceSubmissions, webhook_endpoint: BUDGET.webhookEndpoints,
}

// =====================================================================================================================================================================
// The facts
// =====================================================================================================================================================================
export type FactStatus = 'confirmed' | 'contradicted' | 'not_confirmable'
export type FactDef = { id: string; title: string; assumption: string; method: string; ifContradicted: string; ifNotConfirmable: string }
export const FACTS: readonly FactDef[] = [
  { id: 'T1', title: 'An open Checkout Session is closed by `expire`, and its PaymentIntent (if any) is not succeeded',
    assumption: 'A payment page that nobody paid can be closed by the server, and then nothing can be paid on it.', method: 'Create a session, expire it, read it back with its PaymentIntent.',
    ifContradicted: 'Closing a page before a decision is not reliable: the "no charge" decision stays closed.', ifNotConfirmable: '"No charge" stays refused unless the page is read as expired.' },
  { id: 'T2', title: 'A COMPLETE Checkout Session can not be closed (guided: you pay it with a Stripe test card)',
    assumption: 'Once a customer has paid, `expire` fails and the session stays complete - so the order of "read, close, read again" is safe.',
    method: 'You pay a 1.00 test session; the script then tries `expire` and reads it back. Confirmed only if Stripe REFUSES the call as an unacceptable request (HTTP 400, an invalid request) AND the session is still complete when read back; any other answer - a 5xx, a dropped connection, a timeout, a rate limit, a permission error, a missing object, or no error at all - leaves it not confirmable, and the report records the state the session was found in.',
    ifContradicted: 'A paid session could be closed under the customer: the decision must read the payment, not the page.', ifNotConfirmable: 'The decision never relies on closing a page that might be paid.' },
  { id: 'T3', title: 'After a partial / total refund `amount_refunded` grows and the PaymentIntent stays succeeded',
    assumption: 'A refund does not change the PaymentIntent status: the proof of payment decays only through the refunded amount.', method: 'Pay 1.00 with a test card, refund part, then the rest; read the charge.',
    ifContradicted: 'The refund rule must also look at the PaymentIntent status.', ifNotConfirmable: 'The order stays held after any refund.' },
  { id: 'T4', title: '`refunds.list` for a PaymentIntent returns the refund AT ONCE, with its metadata and its status (10 close reads)',
    assumption: 'A refund we created can be found again by its own metadata (our operation id) and shows its status.', method: 'Create a refund with our metadata and list the PaymentIntent\'s refunds 10 times in a row.',
    ifContradicted: 'The search for an unknown refund can miss one for a while: an operation stays unresolved instead of being concluded (the design already never concludes "absent").', ifNotConfirmable: 'Adoption by metadata stays unavailable.' },
  { id: 'T5', title: 'The same idempotency key twice gives the SAME refund; the same key with other parameters is an error; two requests at once - observed',
    assumption: 'Repeating a refund request with its own key can never pay twice.',
    method: 'Repeat a refund with the same key, then with another amount (only Stripe\'s idempotency error is the refusal: any other error proves nothing), then twice at the same moment (confirmed only if both answers name the same refund, or one request made the refund and the other got the documented conflict `idempotency_key_in_use`, and the list shows ONE refund; two refunds contradict it; an error that is not that conflict, no answer, or a list that does not show the refund yet is not conclusive).',
    ifContradicted: 'The automatic repeat with the same key stays off (RESEND_WITH_SAME_KEY = false): an unknown refund becomes unresolved.', ifNotConfirmable: 'The automatic repeat stays off.' },
  { id: 'T6', title: 'Idempotency keys are kept for 24 hours (not reproducible in one run)',
    assumption: 'Stripe keeps a key for about 24 hours; the design repeats nothing automatically after 20 hours and never relies on 24.', method: 'Not testable in one run: always reported as not confirmable.',
    ifContradicted: 'Not applicable.', ifNotConfirmable: 'The 20-hour margin stays; nothing is repeated after it.' },
  { id: 'T7', title: 'A card that causes a dispute gives `charge.disputed`, a dispute status, and balance transactions (the withdrawal, and the fee apart)',
    assumption: 'The money withdrawn by a dispute is read from the balance transactions, not from the dispute label.', method: 'Pay 1.00 with the test card that creates a dispute; read the charge, the dispute and its balance transactions.',
    ifContradicted: 'The funds position is not computed from balance transactions: P1 changes before it is written.', ifNotConfirmable: 'A lost dispute stays "unverifiable" and blocks the order.' },
  { id: 'T8', title: 'The outcomes `won` and `lost` (test evidence), the funds reinstated, and the events that announce them',
    assumption: 'A lost dispute leaves a withdrawal; a won one reinstates the funds; each announces itself with its own events (lost: `closed` and `funds_withdrawn`; won: `closed` and `funds_reinstated`).',
    method: 'Submit the test evidence for a lost and for a won dispute; read the balance transactions and the events of EACH dispute. Confirmed only if the funds AND the events were all seen; if only the funds were, the fact is not confirmable and the report says which parts were confirmed.',
    ifContradicted: 'The reinstatement rule of P1 is rewritten from what was seen.', ifNotConfirmable: 'A "won" dispute stays unverifiable until the funds are visibly reinstated; events that were not seen were never relied on (a closed dispute is learned by reading it).' },
  { id: 'T9', title: 'What `Charge.disputed` says after the dispute is closed',
    assumption: 'The flag stays true after a won dispute: the code must not use it to decide that a dispute is still open.', method: 'Read the charge of the won dispute.',
    ifContradicted: 'The flag becomes false: still never used alone.', ifNotConfirmable: 'The dispute state is read from the dispute object only.' },
  { id: 'T10', title: '`expand` of `latest_charge.dispute`, with the balance transactions inline',
    assumption: 'One read of the PaymentIntent gives the dispute and its balance transactions.', method: 'Read the PaymentIntent with expand latest_charge.dispute.',
    ifContradicted: 'A second read of the dispute is needed.', ifNotConfirmable: 'A second read of the dispute is needed.' },
  { id: 'T11', title: 'A refund of a charge that is under dispute',
    assumption: 'Stripe refuses to refund a charge that has been charged back (code charge_disputed).', method: 'Try to refund the disputed charge before sending evidence.',
    ifContradicted: 'A refund AND a dispute can both take money: the funds position flags it (overRecovered) and asks for a person.', ifNotConfirmable: 'A refund on a disputed charge is treated as unverifiable.' },
  { id: 'T12', title: '`payment_intents.search` can DISCOVER money, but is not fresh enough to prove its absence',
    assumption: 'Search results lag: it is used to find a payment, never to conclude that there is none.', method: 'Search by our tag right away and every 10 seconds for 90 seconds; record when each payment appears.',
    ifContradicted: 'Not applicable.', ifNotConfirmable: 'Search stays unused, as designed.' },
  { id: 'T13', title: 'The API version in use, and whether the new event types can be subscribed',
    assumption: 'charge.dispute.closed / funds_withdrawn / funds_reinstated and charge.refund.updated can be subscribed on the webhook endpoint.',
    method: 'Create a throw-away endpoint with those events and delete it. Contradicted ONLY if Stripe refuses the event types themselves (an invalid request, HTTP 400, whose parameter is enabled_events) or the endpoint comes back without some of them; a refusal about anything else (the URL, a limit, a permission), a server error or a dropped connection does not show that an event can not be subscribed: not confirmable.',
    ifContradicted: 'Those events are not available: closing a dispute is learned only by reading it.', ifNotConfirmable: 'Closing a dispute is learned by reading it.' },
  { id: 'T14', title: 'The refund states beyond `succeeded` (pending, requires_action, failed, canceled) and how they change',
    assumption: 'The code treats every state that is not succeeded as "not refunded yet" and every unknown state as blocking.',
    method: 'Only if YOU pass a documented test payment method that produces them (--refund-test-pm); otherwise not confirmable. One refund goes through some of these states, never all (failed and canceled are alternative ends), so it is confirmed by what one refund can show: a refund seen OPEN (pending or requires_action) AND a refund seen ending WITHOUT refunding (failed or canceled), with no state outside the five. The report lists the states observed and the states NOT observed; a state nobody produced is never counted.',
    ifContradicted: 'A state the code does not know exists: it is added to the table (it blocks until then).', ifNotConfirmable: 'The code stays conservative: every state that is not succeeded is "not refunded yet", an unknown one blocks.' },
  { id: 'T15', title: 'A refund just created is visible AT ONCE in `refunds.list` and in `amount_refunded` (10 close reads)',
    assumption: 'The funds can be read right after the refund (the design does not depend on it: an absence is never a proof).', method: 'Read the PaymentIntent\'s charge 10 times right after creating a refund.',
    ifContradicted: 'A delay exists: it is measured and the design already waits for the absolute state before it applies a result.', ifNotConfirmable: 'The design already waits.' },
  { id: 'T16', title: 'Does `amount_refunded` include a refund that is still pending, and does it go back down when one fails?',
    assumption: 'Not assumed: a refund counts only when succeeded AND read back as applied.',
    method: 'Only with --refund-test-pm: read the amount refunded together with the state of the refund (the state is read before and after the amount; a sample whose state changed is not used) while the refund is pending or requires_action AND after it failed or was canceled. Confirmed only if both moments were caught; otherwise not confirmable, and the report says which half was seen.',
    ifContradicted: 'Not applicable (it is a measurement).', ifNotConfirmable: 'The code waits for the final state.' },
  { id: 'T17', title: 'Repeating a refund with the same key after it succeeded gives the same refund and no second one',
    assumption: 'A repeated click, even late, never refunds twice while the key is still known.', method: 'Send the very first refund request again three times - the same key AND exactly the same parameters, metadata included - and count the refunds of the PaymentIntent.',
    ifContradicted: 'The application never repeats a request that already has an answer.', ifNotConfirmable: 'The application never repeats a request that already has an answer.' },
  { id: 'T18', title: 'What can be cleaned up afterwards, and what stays in the history of Stripe',
    assumption: 'Only an open session (expire), an unpaid PaymentIntent (cancel) and a webhook endpoint (delete) can be removed.', method: 'Try the allowed clean-up on each object and record the outcome.',
    ifContradicted: 'The table in docs/STRIPE-TEST-MODE-S6.md is corrected.', ifNotConfirmable: 'The object stays and is listed in the report.' },
]
export const FACT_IDS = FACTS.map((fact) => fact.id)

export type CleanupOutcome = 'deleted' | 'canceled' | 'expired' | 'voided' | 'detached' | 'remains'
export const CLEANUP_OUTCOMES: readonly CleanupOutcome[] = ['deleted', 'canceled', 'expired', 'voided', 'detached', 'remains']

// =====================================================================================================================================================================
// The key, the arguments, the places a report may go
// =====================================================================================================================================================================
export function refuseKey(key: string | undefined | null): string | null {
  if (!key) return 'STRIPE_SECRET_KEY is not set in this shell (see docs/STRIPE-TEST-MODE-S6.md for how to enter it without showing it).'
  if (/\s/.test(key)) return 'The key contains spaces or line breaks: paste only the key.'
  if (/^(sk|rk)_live_/.test(key)) return 'This is a LIVE key. The script works only with a Stripe TEST key (sk_test_ / rk_test_) and stops here.'
  if (!/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key)) return 'This is not a Stripe test secret key: it must start with sk_test_ or rk_test_.'
  return null
}

export type Options = { dryRun: boolean; reportDir: string | null; currency: string; skipGuided: boolean; refundTestPm: string | null; runId: string; only: string[] | null; yes: boolean }
export function parseArgs(argv: string[]): { options: Options } | { error: string } {
  const options: Options = { dryRun: false, reportDir: null, currency: 'eur', skipGuided: false, refundTestPm: null, runId: randomBytes(4).toString('hex'), only: null, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--skip-guided') options.skipGuided = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--report-dir') options.reportDir = value() ?? null
    else if (arg === '--currency') options.currency = (value() ?? '').toLowerCase()
    else if (arg === '--refund-test-pm') options.refundTestPm = value() ?? null
    else if (arg === '--run-id') options.runId = value() ?? ''
    else if (arg === '--only') options.only = (value() ?? '').split(',').map((id) => id.trim().toUpperCase()).filter(Boolean)
    else return { error: `Unknown option: ${arg}` }
  }
  if (!/^[a-z]{3}$/.test(options.currency)) return { error: '--currency must be a three-letter code such as eur.' }
  if (!/^[A-Za-z0-9-]{4,32}$/.test(options.runId)) return { error: '--run-id must be 4-32 letters, digits or dashes.' }
  if (options.refundTestPm && !/^pm_card_[A-Za-z0-9_]+$/.test(options.refundTestPm)) return { error: '--refund-test-pm must be a Stripe TEST payment method token such as pm_card_visa.' }
  if (options.only) {
    const unknown = options.only.filter((id) => !FACT_IDS.includes(id))
    if (unknown.length > 0) return { error: `Unknown fact(s) in --only: ${unknown.join(', ')}` }
  }
  return { options }
}

// A report may be written only OUTSIDE the repository (and its git work tree): it holds ids of test objects and nothing else, but it is not a file of the project.
export function refuseReportDir(dir: string | null, repoRoot: string): string | null {
  if (!dir) return 'Say where the report goes: --report-dir <a folder outside the repository>.'
  const resolved = path.resolve(dir)
  const root = path.resolve(repoRoot)
  const inside = !path.relative(root, resolved).startsWith('..') && !path.isAbsolute(path.relative(root, resolved))
  if (inside) return `The report folder must be OUTSIDE the repository (${root}).`
  return null
}

// =====================================================================================================================================================================
// What may never leave this process
// =====================================================================================================================================================================
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g,
  /\bwhsec_[A-Za-z0-9]+/g,
  /\bpi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g,
  /\bcs_(test|live)_secret[A-Za-z0-9_]*/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
]
const FORBIDDEN_WORDS = ['client_secret', 'receipt_url', 'receipt_email', 'customer_email', 'last4', 'fingerprint', 'cardholder']
export function redact(text: string, key?: string | null): string {
  let out = String(text)
  if (key) out = out.split(key).join('[key]')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[removed]')
  return out
}
// The last check before a report is written: a key, a secret, a link to a receipt, an address, card data. Throws, so that nothing unsafe is ever saved.
export function assertCleanReport(json: string, key?: string | null) {
  if (key && json.includes(key)) throw new Error('The report contains the API key: it was not written.')
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(json)) throw new Error(`The report contains something that looks like a secret or an address (${pattern.source}): it was not written.`)
  }
  for (const word of FORBIDDEN_WORDS) if (json.includes(word)) throw new Error(`The report mentions "${word}": it was not written.`)
}

// =====================================================================================================================================================================
// A thin gate in front of the Stripe client: budget, live-mode check, call log. Nothing reaches Stripe except through it.
// =====================================================================================================================================================================
export type VerifyStripe = any
export class BudgetError extends Error { constructor(message: string) { super(message); this.name = 'BudgetError' } }
export class LivemodeError extends Error { constructor() { super('A live-mode object was seen: the run stopped. Nothing else was called.'); this.name = 'LivemodeError' } }

function containsLivemode(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 4) return false
  const record = value as Record<string, unknown>
  if (record.livemode === true) return true
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) { if (child.slice(0, 20).some((entry) => containsLivemode(entry, depth + 1))) return true }
    else if (child && typeof child === 'object' && containsLivemode(child, depth + 1)) return true
  }
  return false
}

export type CallLog = { n: number; name: string; ok: boolean; status: number | null; code: string | null; ms: number }
export class Gate {
  readonly calls: CallLog[] = []
  readonly created: Record<ObjectKind, number> = { checkout_session: 0, payment_intent: 0, refund: 0, dispute_evidence: 0, webhook_endpoint: 0 }
  amountCents = 0
  private readonly startedAt: number
  constructor(readonly stripe: VerifyStripe, private readonly now: () => number = Date.now) { this.startedAt = now() }
  get elapsedMs() { return this.now() - this.startedAt }
  async call<T>(name: string, run: () => Promise<T>, meta: { creates?: ObjectKind; amountCents?: number } = {}): Promise<T> {
    if (this.calls.length >= BUDGET.maxApiCalls) throw new BudgetError(`The limit of ${BUDGET.maxApiCalls} calls was reached.`)
    if (this.elapsedMs > BUDGET.maxRunMs) throw new BudgetError(`The run is longer than ${Math.round(BUDGET.maxRunMs / 60000)} minutes.`)
    if (meta.creates) {
      if (this.created[meta.creates] >= KIND_LIMIT[meta.creates]) throw new BudgetError(`The limit of ${KIND_LIMIT[meta.creates]} ${meta.creates.replace(/_/g, ' ')} objects was reached.`)
      this.created[meta.creates] += 1 // counted BEFORE the call: a call that failed half-way may still have made the object
    }
    if (meta.amountCents) {
      if (meta.amountCents > BUDGET.maxAmountCentsPerPayment) throw new BudgetError(`A payment of ${meta.amountCents} exceeds ${BUDGET.maxAmountCentsPerPayment}.`)
      if (this.amountCents + meta.amountCents > BUDGET.maxAmountCentsTotal) throw new BudgetError(`The total amount would exceed ${BUDGET.maxAmountCentsTotal}.`)
      this.amountCents += meta.amountCents
    }
    const started = this.now()
    try {
      const out = await run()
      this.calls.push({ n: this.calls.length + 1, name, ok: true, status: null, code: null, ms: this.now() - started })
      if (containsLivemode(out)) throw new LivemodeError()
      return out
    } catch (error) {
      if (error instanceof LivemodeError) throw error
      const e = error as { statusCode?: number; code?: string; type?: string }
      this.calls.push({ n: this.calls.length + 1, name, ok: false, status: e?.statusCode ?? null, code: e?.code ?? e?.type ?? null, ms: this.now() - started })
      throw error
    }
  }
}

// What an error teaches us, without anything that could be personal: the kind, the code, the status, a short message.
export function errorFacts(error: unknown) {
  const e = error as { type?: string; code?: string; statusCode?: number; message?: string; raw?: { code?: string; param?: string } }
  return { type: e?.type ?? (error as Error)?.name ?? 'Error', code: e?.code ?? e?.raw?.code ?? null, status: e?.statusCode ?? null, param: e?.raw?.param ?? null, message: redact(String(e?.message ?? '')).slice(0, 160) }
}

// ---- which answers of Stripe PROVE something ----------------------------------------------------------------------------------------------------------------------------
// An error is evidence only when it is the SPECIFIC answer a fact is about. A 5xx, a dropped connection, a timeout, a rate limit (429), a permission or authentication error (403 / 401), a missing
// object (404), a plain error or a stop of this script itself says NOTHING about what Stripe does with a key that is used again or with a session that is already paid: the fact stays NOT
// confirmable - never "refused", never "contradicted". Only the types and codes that the Stripe SDK documents are used (`idempotency_error`, `idempotency_key_in_use`, `invalid_request_error`);
// no code is invented: the SDK documents none for "this session is not open".
type RawStripeError = { type?: string; rawType?: string; code?: string | null; statusCode?: number } | null | undefined
/** Stripe's `idempotency_error`: a key that comes back with other parameters (or for another endpoint). The conflict "key in use" is another answer (isIdempotencyKeyInUse). */
export function isIdempotencyMismatch(error: unknown): boolean {
  const e = error as RawStripeError
  return (e?.rawType === 'idempotency_error' || e?.type === 'StripeIdempotencyError') && !isIdempotencyKeyInUse(error) && e?.statusCode !== 409
}
/** `idempotency_key_in_use`: the key is being used by a request that has not finished - the answer to two requests at the same moment, never to other parameters. */
export function isIdempotencyKeyInUse(error: unknown): boolean {
  return (error as RawStripeError)?.code === 'idempotency_key_in_use'
}
/** A REFUSAL: Stripe processed the request and rejected it as unacceptable - HTTP 400, the SDK's StripeInvalidRequestError. */
export function isRequestRefused(error: unknown): boolean {
  const e = error as RawStripeError
  return e?.type === 'StripeInvalidRequestError' && e?.statusCode === 400
}
/** A refusal that is about the EVENT TYPES of a webhook endpoint: Stripe processed the request and rejected it as unacceptable (HTTP 400, an invalid request) and the parameter it points at - the documented
 *  `param` of the error object - is `enabled_events` (or one entry of it). A refusal about anything else (the URL, a limit...) does not show that an event type can not be subscribed. */
export function isEventTypeRefusal(error: unknown): boolean {
  const e = error as { type?: string; statusCode?: number; param?: unknown; raw?: { param?: unknown } } | null | undefined
  const param = e?.param ?? e?.raw?.param
  return e?.type === 'StripeInvalidRequestError' && e?.statusCode === 400 && typeof param === 'string' && /^enabled_events(?:\[\d*\])?$/.test(param)
}
/** A stop of this script ITSELF - a live-mode object seen, a maximum reached - is not an answer of Stripe: it ends the run (`attempt`, in `run`, records it; nothing is called afterwards, not even the
 *  clean-up). EVERY place that reads an error of Stripe as evidence - every catch, every Promise.allSettled - must let it through, or it would be taken for "Stripe refused" and the run would go on
 *  (a source test checks that no catch is left without it). */
export function stopOnOwnStop(error: unknown): void {
  if (error instanceof LivemodeError || error instanceof BudgetError) throw error
}

// =====================================================================================================================================================================
// The run
// =====================================================================================================================================================================
// A fact that makes several claims (T8, T16) lists them as PARTS: what was confirmed and what was not, one by one. Its status is the status of its WORST part.
export type FactPart = { part: string; status: FactStatus; detail: string }
export type FactResult = { id: string; title: string; status: FactStatus; observed: Record<string, unknown>; note: string; parts?: FactPart[] }
export type CreatedObject = { type: string; id: string; step: string; cleanup: { action: string; outcome: CleanupOutcome; error?: ReturnType<typeof errorFacts> } }
export type Deps = {
  sleep: (ms: number) => Promise<void>
  now: () => number
  prompt: (question: string) => Promise<string>
  say: (line: string) => void
}

const ok = (id: string, observed: Record<string, unknown>, note = ''): FactResult => ({ id, title: titleOf(id), status: 'confirmed', observed, note })
const bad = (id: string, observed: Record<string, unknown>, note: string): FactResult => ({ id, title: titleOf(id), status: 'contradicted', observed, note })
const unknown = (id: string, observed: Record<string, unknown>, note: string): FactResult => ({ id, title: titleOf(id), status: 'not_confirmable', observed, note })
function titleOf(id: string) { return FACTS.find((fact) => fact.id === id)?.title ?? id }
// "confirmed" only when EVERY part of what the title says was seen; one part contradicted -> contradicted; otherwise one part not seen -> not confirmable
const worstOf = (statuses: FactStatus[]): FactStatus => (statuses.includes('contradicted') ? 'contradicted' : statuses.includes('not_confirmable') ? 'not_confirmable' : 'confirmed')
const withParts = (id: string, parts: FactPart[], observed: Record<string, unknown>, note: string): FactResult => ({ id, title: titleOf(id), status: worstOf(parts.map((entry) => entry.status)), observed, note, parts })
// what each part came to, in a sentence: "Confirmed: a, b. NOT confirmed: c. Contradicted: d."
function partsSummary(parts: FactPart[]): string {
  const names = (status: FactStatus) => parts.filter((entry) => entry.status === status).map((entry) => entry.part).join(', ')
  return [['Confirmed', 'confirmed'], ['NOT confirmed', 'not_confirmable'], ['Contradicted', 'contradicted']]
    .map(([label, status]) => (names(status as FactStatus) ? `${label}: ${names(status as FactStatus)}.` : ''))
    .filter(Boolean)
    .join(' ')
}

type Ctx = {
  gate: Gate
  options: Options
  deps: Deps
  runId: string
  objects: CreatedObject[]
  state: Record<string, any>
}
const tag = (ctx: Ctx, step: string, extra: Record<string, string> = {}) => ({ makerworksVerify: ctx.runId, step, ...extra })
const key = (ctx: Ctx, step: string) => `makerworks-verify:${ctx.runId}:${step}`
const track = (ctx: Ctx, type: string, id: string, step: string, action: string) => { ctx.objects.push({ type, id, step, cleanup: { action, outcome: 'remains' } }) }
const wanted = (ctx: Ctx, ...ids: string[]) => !ctx.options.only || ids.some((id) => ctx.options.only!.includes(id))

// a payment made with one of Stripe's test payment-method tokens: no customer, no card data of ours
async function payTestIntent(ctx: Ctx, step: string, token: string) {
  const amount = BUDGET.maxAmountCentsPerPayment
  const pi: any = await ctx.gate.call('paymentIntents.create', () => ctx.gate.stripe.paymentIntents.create({
    amount, currency: ctx.options.currency, payment_method: token, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    description: 'MakerWorks verification (test mode)', metadata: tag(ctx, step),
  }, { idempotencyKey: key(ctx, `${step}:pi`), timeout: BUDGET.perCallTimeoutMs }), { creates: 'payment_intent', amountCents: amount })
  track(ctx, 'payment_intent', pi.id, step, 'cancel (only if not succeeded)')
  return pi
}
const readIntent = (ctx: Ctx, id: string, expand: string[] = ['latest_charge']) => ctx.gate.call('paymentIntents.retrieve', () => ctx.gate.stripe.paymentIntents.retrieve(id, { expand }, { timeout: BUDGET.perCallTimeoutMs }))
const chargeOf = (pi: any) => (pi?.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null)
const summarizeTransactions = (list: any): Array<Record<string, unknown>> => (Array.isArray(list) ? list : []).map((tx: any) => (typeof tx === 'object' && tx
  ? { type: tx.type ?? null, amount: tx.amount ?? null, fee: tx.fee ?? null, net: tx.net ?? null, category: tx.reporting_category ?? null, currency: tx.currency ?? null } : { id_only: true }))

async function poll<T>(ctx: Ctx, read: () => Promise<T>, done: (value: T) => boolean): Promise<{ value: T; attempts: number; ms: number; done: boolean }> {
  const started = ctx.deps.now()
  let value = await read()
  let attempts = 1
  while (!done(value) && attempts < BUDGET.maxPollAttempts) {
    await ctx.deps.sleep(BUDGET.pollIntervalMs)
    value = await read()
    attempts++
  }
  return { value, attempts, ms: ctx.deps.now() - started, done: done(value) }
}

// `canBePaid`: false for a page that is closed at once and that nobody sees (T1): it can not move money, so it does not count toward the money maximum
async function createSession(ctx: Ctx, step: string, canBePaid = true) {
  const amount = BUDGET.maxAmountCentsPerPayment
  const session: any = await ctx.gate.call('checkout.sessions.create', () => ctx.gate.stripe.checkout.sessions.create({
    mode: 'payment', success_url: 'https://example.com/makerworks-verify/success', cancel_url: 'https://example.com/makerworks-verify/cancel',
    line_items: [{ quantity: 1, price_data: { currency: ctx.options.currency, unit_amount: amount, product_data: { name: 'MakerWorks verification (test mode)' } } }],
    metadata: tag(ctx, step),
  }, { idempotencyKey: key(ctx, `${step}:session`), timeout: BUDGET.perCallTimeoutMs }), { creates: 'checkout_session', ...(canBePaid ? { amountCents: amount } : {}) })
  track(ctx, 'checkout_session', session.id, step, 'expire (only if open)')
  return session
}

// ---- T1 ---------------------------------------------------------------------------------------------------------------------------------------------------------
async function t1(ctx: Ctx): Promise<FactResult> {
  const session = await createSession(ctx, 'T1', false)
  const before = session.status
  const expired: any = await ctx.gate.call('checkout.sessions.expire', () => ctx.gate.stripe.checkout.sessions.expire(session.id, {}, { timeout: BUDGET.perCallTimeoutMs }))
  const after: any = await ctx.gate.call('checkout.sessions.retrieve', () => ctx.gate.stripe.checkout.sessions.retrieve(session.id, { expand: ['payment_intent'] }, { timeout: BUDGET.perCallTimeoutMs }))
  const intent = after.payment_intent && typeof after.payment_intent === 'object' ? after.payment_intent : null
  const observed = { statusBefore: before, statusAfterExpire: expired?.status ?? null, statusRead: after.status, paymentIntentExists: Boolean(after.payment_intent), paymentIntentStatus: intent?.status ?? null }
  ctx.state.session1 = session.id
  setOutcome(ctx, session.id, after.status === 'expired' ? 'expired' : 'remains')
  const good = before === 'open' && after.status === 'expired' && (!intent || intent.status !== 'succeeded')
  return good ? ok('T1', observed) : bad('T1', observed, 'The session was not closed as expected.')
}

// ---- T2 (guided) ----------------------------------------------------------------------------------------------------------------------------------------------
async function t2(ctx: Ctx): Promise<FactResult> {
  if (ctx.options.skipGuided) return unknown('T2', { skipped: true }, 'Skipped (--skip-guided): the guided payment was not made.')
  const session = await createSession(ctx, 'T2')
  ctx.deps.say('')
  ctx.deps.say('GUIDED STEP (T2): open this Stripe TEST payment page in your browser and pay it with a Stripe TEST card (see the guide). Any e-mail address will do.')
  ctx.deps.say(`   ${session.url}`)
  const answer = (await ctx.deps.prompt('When you have paid (or decided to skip), press Enter. Type "skip" to skip: ')).trim().toLowerCase()
  if (answer === 'skip') { setOutcome(ctx, session.id, 'remains'); return unknown('T2', { skipped: true }, 'Skipped by you at the prompt.') }
  const read = () => ctx.gate.call('checkout.sessions.retrieve', () => ctx.gate.stripe.checkout.sessions.retrieve(session.id, { expand: ['payment_intent'] }, { timeout: BUDGET.perCallTimeoutMs }))
  const complete = await poll(ctx, read, (value: any) => value?.status === 'complete')
  const seen: any = complete.value
  if (!complete.done) {
    // not paid: close it so that it does not stay open, and say so
    try { await ctx.gate.call('checkout.sessions.expire', () => ctx.gate.stripe.checkout.sessions.expire(session.id, {}, { timeout: BUDGET.perCallTimeoutMs })); setOutcome(ctx, session.id, 'expired') } catch (error) { stopOnOwnStop(error) /* otherwise: it expires by itself */ }
    return unknown('T2', { status: seen?.status ?? null, polls: complete.attempts }, 'The page was not paid, so the question could not be asked.')
  }
  setOutcome(ctx, session.id, 'remains')
  const intentId = typeof seen.payment_intent === 'object' ? seen.payment_intent?.id : seen.payment_intent
  if (intentId) { track(ctx, 'payment_intent', String(intentId), 'T2', 'none (created by Stripe for the paid session)'); ctx.gate.created.payment_intent += 1 }
  let expireError: ReturnType<typeof errorFacts> | null = null
  let refused = false
  let expireStatus: string | null = null
  try {
    const result: any = await ctx.gate.call('checkout.sessions.expire', () => ctx.gate.stripe.checkout.sessions.expire(session.id, {}, { timeout: BUDGET.perCallTimeoutMs }))
    expireStatus = result?.status ?? null
  } catch (error) { stopOnOwnStop(error); expireError = errorFacts(error); refused = isRequestRefused(error) }
  const after: any = await read()
  // What `expire` answered: a REFUSAL (the request was processed and rejected as unacceptable, HTTP 400), another error (a 5xx, a dropped connection, a timeout, a rate limit, a permission error, a
  // missing object: none of them shows what `expire` does to a paid session), or no error at all. And what the session IS now, read back: that is what matters most.
  const expireAnswer = expireError === null ? 'no_error' : refused ? 'refused' : 'other_error'
  const unchanged = after.status === 'complete'
  const observed = { statusWhenPaid: seen.status, paymentStatusWhenPaid: seen.payment_status, expireAnswer, expireRefused: refused, expireError, statusAfter: after.status, expireReturnedStatus: expireStatus }
  const parts: FactPart[] = [
    {
      part: 'session_stays_complete', status: unchanged ? 'confirmed' : 'contradicted',
      detail: unchanged ? 'The paid session was read back after expire was tried and it is still complete.' : `The paid session was "${seen.status}" when it was paid and "${after.status}" after expire was tried: a paid session changed state.`,
    },
    {
      part: 'expire_refused_by_stripe', status: refused ? 'confirmed' : 'not_confirmable',
      detail: refused ? `Stripe rejected the call as an unacceptable request (${expireError?.type}, HTTP ${expireError?.status}).`
        : expireAnswer === 'no_error' ? 'expire returned without an error: Stripe did not refuse the call.'
          : `The call failed with ${expireError?.type ?? 'an error'}${expireError?.status ? ` (HTTP ${expireError.status})` : ''}, which is not a refusal of the request: a 5xx, a dropped connection, a timeout, a rate limit, a permission error or a missing object proves nothing about what expire does to a paid session.`,
    },
  ]
  return withParts('T2', parts, observed, `${partsSummary(parts)} The session was "${seen.status}" when it was paid and "${after.status}" after expire was tried.`)
}

// ---- T5, two requests at the same moment: what the ANSWERS and the LIST of refunds show together ------------------------------------------------------------------------
// Confirmed only by the same refund named by both answers, or by one refund plus the documented conflict `idempotency_key_in_use` - and in both cases the list shows ONE refund for the key.
// Contradicted by two refunds, named by the answers or counted in the list. Everything else - an error that is not the documented conflict, no answer at all, a list that does not show the
// refund yet - proves nothing: a transient error is not a confirmation, and the absence of an answer is not a contradiction.
export type ConcurrentAnswer = 'same_refund_twice' | 'one_refund_one_conflict' | 'two_refunds_created' | 'inconclusive'
export function concurrentAnswerOf(settled: ReadonlyArray<PromiseSettledResult<unknown>>, listed: number): ConcurrentAnswer {
  const ids = settled.flatMap((entry) => {
    const id = entry.status === 'fulfilled' ? (entry.value as { id?: unknown } | null | undefined)?.id : undefined
    return typeof id === 'string' ? [id] : []
  })
  const failures = settled.flatMap((entry) => (entry.status === 'rejected' ? [entry.reason as unknown] : []))
  if (listed >= 2 || (ids.length === 2 && ids[0] !== ids[1])) return 'two_refunds_created'
  if (listed === 1 && ids.length === 2 && ids[0] === ids[1] && failures.length === 0) return 'same_refund_twice'
  if (listed === 1 && ids.length === 1 && failures.length === 1 && isIdempotencyKeyInUse(failures[0])) return 'one_refund_one_conflict'
  return 'inconclusive'
}

// ---- T3, T4, T5, T15, T17: one PaymentIntent, a series of refunds ---------------------------------------------------------------------------------
async function refundFacts(ctx: Ctx): Promise<FactResult[]> {
  const results: FactResult[] = []
  const pi = await payTestIntent(ctx, 'T3', 'pm_card_visa')
  ctx.state.pi1 = pi.id
  if (pi.status !== 'succeeded') {
    const reason = `The test payment is ${pi.status}, not succeeded: the refund facts could not be asked.`
    return ['T3', 'T4', 'T5', 'T15', 'T17'].filter((id) => wanted(ctx, id)).map((id) => unknown(id, { paymentIntentStatus: pi.status }, reason))
  }
  // A refund REQUEST is built once and sent as often as the step needs it. A repeat of a request must be EXACTLY the first one - the same key AND the same parameters, metadata
  // included: Stripe refuses a key that comes back with other parameters (idempotency_error). So the repeats below send the very same object; "T17" names the RESULT of the test,
  // never a parameter of the request. The only request that differs on purpose is the "same key, another amount" of T5, and it is expected to be refused.
  const refundRequest = (step: string, amount: number, opId: string, idem?: string) => ({
    params: { payment_intent: pi.id as string, amount, reason: 'requested_by_customer' as const, metadata: tag(ctx, step, { makerworksOperationId: opId, makerworksOrderId: `verify-${ctx.runId}` }) },
    options: { idempotencyKey: idem ?? `makerworks:refund-op:${opId}`, timeout: BUDGET.perCallTimeoutMs },
  })
  const sendRefund = (request: ReturnType<typeof refundRequest>) => ctx.gate.call('refunds.create', () => ctx.gate.stripe.refunds.create(request.params, request.options), { creates: 'refund' })
  const refundOf = (step: string, amount: number, opId: string, idem?: string) => sendRefund(refundRequest(step, amount, opId, idem))
  const opA = randomUUID()
  const requestA = refundRequest('T4', 20, opA)
  const refundA: any = await sendRefund(requestA)
  track(ctx, 'refund', refundA.id, 'T4', 'none (a refund can not be deleted)')

  // T4 + T15: ten close reads
  const listings: Array<{ found: boolean; metadataOk: boolean; statusOk: boolean }> = []
  const amounts: Array<number | null> = []
  for (let i = 0; i < 10; i++) {
    const list: any = await ctx.gate.call('refunds.list', () => ctx.gate.stripe.refunds.list({ payment_intent: pi.id, limit: 10 }, { timeout: BUDGET.perCallTimeoutMs }))
    const entry = (list?.data ?? []).find((refund: any) => refund.id === refundA.id)
    listings.push({ found: Boolean(entry), metadataOk: entry?.metadata?.makerworksOperationId === opA, statusOk: typeof entry?.status === 'string' })
  }
  for (let i = 0; i < 10; i++) {
    const read: any = await readIntent(ctx, pi.id)
    amounts.push(chargeOf(read)?.amount_refunded ?? null)
  }
  const found = listings.filter((entry) => entry.found).length
  const full = listings.filter((entry) => entry.found && entry.metadataOk && entry.statusOk).length
  const seenAmount = amounts.filter((amount) => amount === 20).length
  if (wanted(ctx, 'T4')) results.push(full === 10 ? ok('T4', { reads: 10, found, withMetadataAndStatus: full, refundStatus: refundA.status ?? null }) : bad('T4', { reads: 10, found, withMetadataAndStatus: full }, 'The refund was not found with its metadata and status on every close read.'))
  if (wanted(ctx, 'T15')) results.push(found === 10 && seenAmount === 10 ? ok('T15', { reads: 10, listedEachTime: found, amountRefundedCorrectEachTime: seenAmount }) : bad('T15', { reads: 10, listedEachTime: found, amountRefundedCorrectEachTime: seenAmount, amountsSeen: [...new Set(amounts)] }, 'A delay was observed between creating a refund and seeing it.'))

  // T3 (partial) is read here; the total follows after T5
  const partial: any = await readIntent(ctx, pi.id)
  const partialCharge = chargeOf(partial)

  // T5: the same key twice, the same key with another amount, two at once
  const opB = randomUUID()
  const requestB = refundRequest('T5', 10, opB)
  const first: any = await sendRefund(requestB)
  track(ctx, 'refund', first.id, 'T5', 'none (a refund can not be deleted)')
  const second: any = await sendRefund(requestB)
  let mismatch: ReturnType<typeof errorFacts> | null = null
  // the ONE request that differs from the first of its key on purpose: another amount (Stripe is expected to refuse it). Only Stripe's idempotency error is that refusal: any other error - a 5xx,
  // a dropped connection, a timeout, a rate limit, a permission error, the "key in use" conflict - says nothing about what Stripe does with other parameters under a used key.
  let otherAmount: 'idempotency_error' | 'other_error' | 'accepted' = 'accepted'
  try { await sendRefund(refundRequest('T5', 11, opB)) } catch (error) { stopOnOwnStop(error); mismatch = errorFacts(error); otherAmount = isIdempotencyMismatch(error) ? 'idempotency_error' : 'other_error' }
  const opC = randomUUID()
  const requestC = refundRequest('T5', 10, opC)
  const concurrent = await Promise.allSettled([sendRefund(requestC), sendRefund(requestC)])
  for (const entry of concurrent) if (entry.status === 'rejected') stopOnOwnStop(entry.reason)
  const concurrentIds = concurrent.filter((entry) => entry.status === 'fulfilled').map((entry) => (entry as PromiseFulfilledResult<any>).value.id as string)
  for (const id of new Set(concurrentIds)) track(ctx, 'refund', id, 'T5', 'none (a refund can not be deleted)')
  const concurrentErrors = concurrent.filter((entry) => entry.status === 'rejected').map((entry) => errorFacts((entry as PromiseRejectedResult).reason))
  const afterT5: any = await ctx.gate.call('refunds.list', () => ctx.gate.stripe.refunds.list({ payment_intent: pi.id, limit: 20 }, { timeout: BUDGET.perCallTimeoutMs }))
  const withC = (afterT5?.data ?? []).filter((refund: any) => refund.metadata?.makerworksOperationId === opC).length
  const sequentialSame = first.id === second.id && first.status === second.status
  const concurrentOutcome = concurrentIds.length === 2 && concurrentIds[0] === concurrentIds[1] ? 'same_refund_twice' : concurrentIds.length === 1 && concurrentErrors.length === 1 ? `one_refund_one_error:${concurrentErrors[0].code ?? concurrentErrors[0].type}` : concurrentIds.length === 2 ? 'two_different_refunds' : 'other'
  const concurrentAnswer = concurrentAnswerOf(concurrent, withC)
  if (wanted(ctx, 'T5')) {
    const observed = { sequentialSameRefund: sequentialSame, sameKeyOtherAmountAnswer: otherAmount, sameKeyOtherAmountError: mismatch, concurrentOutcome, concurrentAnswer, concurrentErrors, refundsMadeForTheConcurrentKey: withC }
    const shown = (facts: ReturnType<typeof errorFacts> | null) => `${facts?.type ?? 'an error'}${facts?.status ? `, HTTP ${facts.status}` : ''}${facts?.code ? `, ${facts.code}` : ''}`
    const parts: FactPart[] = [
      {
        part: 'same_key_same_request', status: sequentialSame ? 'confirmed' : 'contradicted',
        detail: sequentialSame ? 'The same request sent twice under one key gave the same refund (same id, same status).' : 'The same request sent twice under one key gave two different answers (two refunds, or two states).',
      },
      {
        part: 'same_key_other_amount_refused', status: otherAmount === 'idempotency_error' ? 'confirmed' : otherAmount === 'accepted' ? 'contradicted' : 'not_confirmable',
        detail: otherAmount === 'idempotency_error' ? `Stripe refused another amount under a key already used, with its idempotency error (${shown(mismatch)}).`
          : otherAmount === 'accepted' ? 'Stripe took another amount under a key already used: no error was raised.'
            : `The request with another amount failed with ${shown(mismatch)}, which is not an idempotency error: a 5xx, a dropped connection, a timeout, a rate limit or a permission error proves nothing about what Stripe does with other parameters.`,
      },
      {
        part: 'two_at_once_one_refund', status: concurrentAnswer === 'two_refunds_created' ? 'contradicted' : concurrentAnswer === 'inconclusive' ? 'not_confirmable' : 'confirmed',
        detail: concurrentAnswer === 'same_refund_twice' ? 'Two requests at the same moment under one key were both answered with the same refund, and the list shows one refund for the key.'
          : concurrentAnswer === 'one_refund_one_conflict' ? 'One request made the refund and the other was refused with the documented conflict (idempotency_key_in_use); the list shows one refund for the key.'
            : concurrentAnswer === 'two_refunds_created' ? `More than one refund exists for one key (${withC} in the list; the answers named ${new Set(concurrentIds).size} refund${new Set(concurrentIds).size === 1 ? '' : 's'}).`
              : `No conclusion: ${concurrentIds.length} answer${concurrentIds.length === 1 ? '' : 's'} with a refund, ${concurrentErrors.length} error${concurrentErrors.length === 1 ? '' : 's'} (${concurrentErrors.map(shown).join('; ') || 'none'}), ${withC} refund${withC === 1 ? '' : 's'} in the list. An error that is not the documented conflict, no answer at all, or a list that does not show the refund yet proves nothing about two requests at the same moment.`,
      },
    ]
    const note = [
      partsSummary(parts),
      otherAmount === 'other_error' ? 'The answer to the request with another amount was not an idempotency error, so it proves nothing about idempotency: run T5 again (--only T5).' : '',
      concurrentAnswer === 'inconclusive' ? 'The two requests at the same moment gave no conclusive answer: run T5 again (--only T5).' : '',
    ].filter(Boolean).join(' ')
    results.push(withParts('T5', parts, observed, note))
  }

  // T17: three late repeats of the FIRST request - the very object T4 sent (same key, same parameters, metadata included)
  const repeats: any[] = []
  for (let i = 0; i < 3; i++) repeats.push(await sendRefund(requestA))
  const afterT17: any = await ctx.gate.call('refunds.list', () => ctx.gate.stripe.refunds.list({ payment_intent: pi.id, limit: 20 }, { timeout: BUDGET.perCallTimeoutMs }))
  const forA = (afterT17?.data ?? []).filter((refund: any) => refund.metadata?.makerworksOperationId === opA).length
  const sameAll = repeats.every((refund) => refund.id === refundA.id && refund.status === refundA.status)
  if (wanted(ctx, 'T17')) {
    const observed = { repeats: 3, repeatedRequest: 'the first request of step T4, sent again exactly as it was', sameRefundEachTime: sameAll, refundsForTheKey: forA, inFlightRepeat: concurrentOutcome }
    results.push(sameAll && forA === 1 ? ok('T17', observed) : bad('T17', observed, 'A repeated request made another refund or another answer.'))
  }

  // T3: the rest, then the total
  const before: any = await readIntent(ctx, pi.id)
  const left = pi.amount - (chargeOf(before)?.amount_refunded ?? 0)
  if (left > 0) {
    const last: any = await refundOf('T3', left, randomUUID())
    track(ctx, 'refund', last.id, 'T3', 'none (a refund can not be deleted)')
  }
  const done: any = await readIntent(ctx, pi.id)
  const doneCharge = chargeOf(done)
  if (wanted(ctx, 'T3')) {
    const observed = {
      partialAmountRefunded: partialCharge?.amount_refunded ?? null, partialRefundedFlag: partialCharge?.refunded ?? null, paymentIntentStatusAfterPartial: partial.status,
      totalAmountRefunded: doneCharge?.amount_refunded ?? null, totalRefundedFlag: doneCharge?.refunded ?? null, paymentIntentStatusAfterTotal: done.status, paid: pi.amount,
    }
    const good = observed.partialAmountRefunded === 20 && observed.partialRefundedFlag === false && partial.status === 'succeeded' && observed.totalAmountRefunded === pi.amount && observed.totalRefundedFlag === true && done.status === 'succeeded'
    results.push(good ? ok('T3', observed) : bad('T3', observed, 'The refunded amount or the PaymentIntent status was not as assumed.'))
  }
  return results
}

// ---- T7, T8, T9, T10, T11: two disputes -----------------------------------------------------------------------------------------------------------------
const DISPUTE_CLOSED = 'charge.dispute.closed'
const DISPUTE_FUNDS_WITHDRAWN = 'charge.dispute.funds_withdrawn'
const DISPUTE_FUNDS_REINSTATED = 'charge.dispute.funds_reinstated'
async function disputeFacts(ctx: Ctx): Promise<FactResult[]> {
  const results: FactResult[] = []
  const wait = async (id: string) => poll(ctx, () => readIntent(ctx, id, ['latest_charge.dispute']), (pi: any) => Boolean(chargeOf(pi)?.dispute && typeof chargeOf(pi).dispute === 'object'))

  // the dispute that will be LOST
  const lostPi = await payTestIntent(ctx, 'T7', 'pm_card_createDispute')
  ctx.state.pi2 = lostPi.id
  const seen: any = await wait(lostPi.id)
  const charge: any = chargeOf(seen.value)
  const dispute: any = charge?.dispute && typeof charge.dispute === 'object' ? charge.dispute : null
  const transactions = summarizeTransactions(dispute?.balance_transactions)
  const withdrawal = transactions.find((tx) => typeof tx.amount === 'number' && (tx.amount as number) < 0 && Math.abs(tx.amount as number) === dispute?.amount)
  if (wanted(ctx, 'T7')) {
    const observed = { disputeSeenAfterMs: seen.ms, polls: seen.attempts, chargeDisputed: charge?.disputed ?? null, disputeStatus: dispute?.status ?? null, disputeReason: dispute?.reason ?? null, disputeAmount: dispute?.amount ?? null, balanceTransactions: transactions, withdrawalOfTheDisputedAmountFound: Boolean(withdrawal) }
    results.push(!dispute ? unknown('T7', observed, 'No dispute appeared in time.')
      : charge.disputed === true && ['needs_response', 'warning_needs_response'].includes(dispute.status) && withdrawal ? ok('T7', observed)
        : bad('T7', observed, 'The charge, the dispute status or the withdrawal was not as assumed.'))
  }
  if (wanted(ctx, 'T10')) {
    const inline = Array.isArray(dispute?.balance_transactions) && dispute.balance_transactions.length > 0 && typeof dispute.balance_transactions[0] === 'object'
    const observed = { expandedDisputeIsAnObject: Boolean(dispute), balanceTransactionsInline: inline }
    results.push(!dispute ? unknown('T10', observed, 'No dispute to read.') : inline ? ok('T10', observed) : bad('T10', observed, 'The dispute or its balance transactions did not come in the same read.'))
  }
  // T11: a refund while it is disputed
  if (dispute && wanted(ctx, 'T11')) {
    try {
      const refund: any = await ctx.gate.call('refunds.create', () => ctx.gate.stripe.refunds.create({ payment_intent: lostPi.id, amount: 10, metadata: tag(ctx, 'T11') }, { idempotencyKey: key(ctx, 'T11:refund'), timeout: BUDGET.perCallTimeoutMs }), { creates: 'refund' })
      track(ctx, 'refund', refund.id, 'T11', 'none (a refund can not be deleted)')
      results.push(bad('T11', { outcome: 'accepted', refundStatus: refund.status ?? null }, 'Stripe accepted a refund of a charge under dispute.'))
    } catch (error) {
      stopOnOwnStop(error)
      const facts = errorFacts(error)
      results.push(facts.code === 'charge_disputed' ? ok('T11', { outcome: 'refused', error: facts }) : unknown('T11', { outcome: 'refused', error: facts }, 'The refund was refused, but not with the code charge_disputed: the reason is in the report.'))
    }
  } else if (wanted(ctx, 'T11')) results.push(unknown('T11', { disputeFound: false }, 'There was no dispute to refund against.'))

  // T8: lose it ...
  let lostStatus: string | null = null
  let lostTransactions: Array<Record<string, unknown>> = []
  // the events that announced the two disputes, kept apart: a required event counts only for ITS dispute
  let eventsLost: string[] = []
  let eventsWon: string[] = []
  let eventsReadable = false
  let eventsError: ReturnType<typeof errorFacts> | null = null
  if (dispute && wanted(ctx, 'T8', 'T9')) {
    await ctx.gate.call('disputes.update', () => ctx.gate.stripe.disputes.update(dispute.id, { evidence: { uncategorized_text: 'losing_evidence' }, submit: true, metadata: tag(ctx, 'T8') }, { timeout: BUDGET.perCallTimeoutMs }), { creates: 'dispute_evidence' })
    const closed = await poll(ctx, () => ctx.gate.call('disputes.retrieve', () => ctx.gate.stripe.disputes.retrieve(dispute.id, {}, { timeout: BUDGET.perCallTimeoutMs })), (value: any) => ['lost', 'won'].includes(value?.status))
    lostStatus = (closed.value as any)?.status ?? null
    lostTransactions = summarizeTransactions((closed.value as any)?.balance_transactions)
  }
  // ... and win another one
  let wonStatus: string | null = null
  let wonTransactions: Array<Record<string, unknown>> = []
  let wonChargeDisputed: boolean | null = null
  let wonDisputeId: string | null = null
  if (wanted(ctx, 'T8', 'T9')) {
    const wonPi = await payTestIntent(ctx, 'T8', 'pm_card_createDispute')
    ctx.state.pi3 = wonPi.id
    const wonSeen: any = await wait(wonPi.id)
    const wonDispute: any = chargeOf(wonSeen.value)?.dispute
    if (wonDispute && typeof wonDispute === 'object') {
      wonDisputeId = wonDispute.id
      await ctx.gate.call('disputes.update', () => ctx.gate.stripe.disputes.update(wonDispute.id, { evidence: { uncategorized_text: 'winning_evidence' }, submit: true, metadata: tag(ctx, 'T8') }, { timeout: BUDGET.perCallTimeoutMs }), { creates: 'dispute_evidence' })
      const closed = await poll(ctx, () => ctx.gate.call('disputes.retrieve', () => ctx.gate.stripe.disputes.retrieve(wonDispute.id, {}, { timeout: BUDGET.perCallTimeoutMs })), (value: any) => ['lost', 'won'].includes(value?.status))
      wonStatus = (closed.value as any)?.status ?? null
      wonTransactions = summarizeTransactions((closed.value as any)?.balance_transactions)
      const after: any = await readIntent(ctx, wonPi.id)
      wonChargeDisputed = chargeOf(after)?.disputed ?? null
    }
    // the events that announced all this (read-only), attributed to THEIR dispute. One read: an event that is not in it is "not seen", which is never a contradiction.
    try {
      const list: any = await ctx.gate.call('events.list', () => ctx.gate.stripe.events.list({ types: ['charge.dispute.created', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.updated'], limit: 50 }, { timeout: BUDGET.perCallTimeoutMs }))
      eventsReadable = true
      const typesOf = (id: string | null | undefined) => (id ? [...new Set<string>((list?.data ?? []).filter((event: any) => event?.data?.object?.id === id).map((event: any) => String(event.type)))].sort() : [])
      eventsLost = typesOf(dispute?.id)
      eventsWon = typesOf(wonDisputeId)
    } catch (error) { stopOnOwnStop(error); eventsError = errorFacts(error) }
  }
  if (wanted(ctx, 'T8')) {
    const reinstated = wonTransactions.some((tx) => typeof tx.amount === 'number' && (tx.amount as number) > 0)
    const withdrawnLost = lostTransactions.some((tx) => typeof tx.amount === 'number' && (tx.amount as number) < 0)
    // what each dispute must have announced (the funds say WHAT happened; the events are a separate claim, and are confirmed only if they were seen)
    const eventsRequired = { lost: [DISPUTE_CLOSED, DISPUTE_FUNDS_WITHDRAWN], won: [DISPUTE_CLOSED, DISPUTE_FUNDS_REINSTATED] }
    const eventsMissing = { lost: eventsRequired.lost.filter((type) => !eventsLost.includes(type)), won: eventsRequired.won.filter((type) => !eventsWon.includes(type)) }
    const observed = {
      lostStatus, wonStatus, lostHasWithdrawal: withdrawnLost, wonHasReinstatement: reinstated, lostBalanceTransactions: lostTransactions, wonBalanceTransactions: wonTransactions,
      eventTypesSeen: [...new Set([...eventsLost, ...eventsWon])].sort(), eventsRequired, eventsSeenByDispute: { lost: eventsLost, won: eventsWon }, eventsMissing, eventsReadable, ...(eventsError ? { eventsError } : {}),
    }
    if (lostStatus === null || wonStatus === null) results.push(unknown('T8', observed, 'A dispute did not close in time (or none appeared).'))
    else {
      const outcomesOk = lostStatus === 'lost' && wonStatus === 'won'
      const eventsOk = eventsMissing.lost.length === 0 && eventsMissing.won.length === 0
      const parts: FactPart[] = [
        { part: 'outcomes', status: outcomesOk ? 'confirmed' : 'contradicted', detail: `The first dispute ended "${lostStatus}" and the second "${wonStatus}" (expected: lost and won).` },
        { part: 'withdrawal_on_lost', status: withdrawnLost ? 'confirmed' : 'contradicted', detail: withdrawnLost ? 'The lost dispute shows a withdrawal in its balance transactions.' : 'The lost dispute shows no withdrawal in its balance transactions.' },
        { part: 'reinstatement_on_won', status: reinstated ? 'confirmed' : 'contradicted', detail: reinstated ? 'The won dispute shows a reinstatement in its balance transactions.' : 'The won dispute shows no reinstatement in its balance transactions.' },
        {
          part: 'events', status: eventsOk ? 'confirmed' : 'not_confirmable',
          detail: eventsOk ? 'Every required event was seen for its own dispute (lost: closed, funds_withdrawn; won: closed, funds_reinstated).'
            : !eventsReadable ? `The list of events could not be read (${eventsError?.code ?? eventsError?.type ?? 'error'}): none of the required events was observed.`
              : `Not seen - lost dispute: ${eventsMissing.lost.join(', ') || 'none'}; won dispute: ${eventsMissing.won.join(', ') || 'none'}.`,
        },
      ]
      const names = (status: FactStatus) => parts.filter((entry) => entry.status === status).map((entry) => entry.part).join(', ')
      const note = parts.every((entry) => entry.status === 'confirmed') ? 'The outcomes, the withdrawal, the reinstatement and the events of each dispute were all seen.'
        : parts.some((entry) => entry.status === 'contradicted') ? `Contradicted: ${names('contradicted')}. The outcome, the withdrawal or the reinstatement was not as assumed.${names('confirmed') ? ` Confirmed: ${names('confirmed')}.` : ''}`
          : `Confirmed: ${names('confirmed')} (read from the balance transactions). NOT confirmed: ${names('not_confirmable')} - the events that announce them were not all seen. The application does not rely on events to learn that a dispute closed: it reads the dispute.`
      results.push(withParts('T8', parts, observed, note))
    }
  }
  if (wanted(ctx, 'T9')) {
    const observed = { chargeDisputedAfterWon: wonChargeDisputed, wonStatus }
    results.push(wonChargeDisputed === null ? unknown('T9', observed, 'The won dispute could not be read.') : wonChargeDisputed === true ? ok('T9', observed, 'The flag stays true: it must never be used alone.') : bad('T9', observed, 'The flag went back to false after the dispute was won.'))
  }
  return results
}

// ---- T12: search --------------------------------------------------------------------------------------------------------------------------------------------
async function t12(ctx: Ctx): Promise<FactResult> {
  const expected = [ctx.state.pi1, ctx.state.pi2, ctx.state.pi3].filter(Boolean) as string[]
  if (expected.length === 0) return unknown('T12', {}, 'No payment was made to search for.')
  const seenAt: Record<string, number> = {}
  const started = ctx.deps.now()
  const firstMiss: string[] = []
  let first = true
  let error: ReturnType<typeof errorFacts> | null = null
  while (ctx.deps.now() - started <= BUDGET.searchWindowMs) {
    try {
      const found: any = await ctx.gate.call('paymentIntents.search', () => ctx.gate.stripe.paymentIntents.search({ query: `metadata['makerworksVerify']:'${ctx.runId}'`, limit: 20 }, { timeout: BUDGET.perCallTimeoutMs }))
      const ids = new Set<string>((found?.data ?? []).map((entry: any) => entry.id))
      for (const id of expected) if (ids.has(id) && seenAt[id] === undefined) seenAt[id] = ctx.deps.now() - started
      if (first) { firstMiss.push(...expected.filter((id) => !ids.has(id))); first = false }
    } catch (e) { stopOnOwnStop(e); error = errorFacts(e); break }
    if (expected.every((id) => seenAt[id] !== undefined)) break
    await ctx.deps.sleep(BUDGET.searchIntervalMs)
  }
  const found = expected.filter((id) => seenAt[id] !== undefined)
  const observed = { searched: expected.length, found: found.length, missedOnTheFirstSearch: firstMiss.length, secondsUntilAllSeen: found.length === expected.length ? Math.round(Math.max(...Object.values(seenAt)) / 1000) : null, error }
  if (error) return unknown('T12', observed, 'Search could not be used (permission, region or feature).')
  return found.length === expected.length ? ok('T12', observed, firstMiss.length > 0 ? 'Search lagged behind: it can discover a payment, it can not prove there is none.' : 'Every payment was found at once; the design still never uses search to exclude a payment.') : unknown('T12', observed, 'Some payments did not appear in search within the time allowed.')
}

// ---- T13: the API version and the event types ---------------------------------------------------------------------------------------------------------------
const NEW_EVENTS = ['charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.created', 'charge.refund.updated', 'charge.refunded', 'checkout.session.completed', 'checkout.session.expired', 'payment_intent.succeeded']
async function t13(ctx: Ctx): Promise<FactResult> {
  const pinned = (Stripe as unknown as { API_VERSION?: string }).API_VERSION ?? null
  try {
    const endpoint: any = await ctx.gate.call('webhookEndpoints.create', () => ctx.gate.stripe.webhookEndpoints.create({
      url: `https://example.com/makerworks-verify/${ctx.runId}`, enabled_events: NEW_EVENTS, description: 'MakerWorks verification (deleted at once)', metadata: tag(ctx, 'T13'),
    }, { idempotencyKey: key(ctx, 'T13:endpoint'), timeout: BUDGET.perCallTimeoutMs }), { creates: 'webhook_endpoint' })
    const id = endpoint.id as string
    const echoed: string[] = Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events : []
    const header = endpoint?.lastResponse?.headers?.['stripe-version'] ?? null
    track(ctx, 'webhook_endpoint', id, 'T13', 'delete')
    delete endpoint.secret // the signing secret of the endpoint: dropped at once, never kept
    try {
      await ctx.gate.call('webhookEndpoints.del', () => ctx.gate.stripe.webhookEndpoints.del(id, {}, { timeout: BUDGET.perCallTimeoutMs }))
      setOutcome(ctx, id, 'deleted')
    } catch (error) { stopOnOwnStop(error); setOutcome(ctx, id, 'remains') }
    const missing = NEW_EVENTS.filter((event) => !echoed.includes(event))
    const observed = { pinnedApiVersion: pinned, responseApiVersion: header, subscribedAll: missing.length === 0, missingEvents: missing, endpointApiVersion: endpoint.api_version ?? null }
    return missing.length === 0 ? ok('T13', observed) : bad('T13', observed, 'Some event types were not accepted on the endpoint.')
  } catch (error) {
    stopOnOwnStop(error)
    const facts = errorFacts(error)
    // Contradicted ONLY by a refusal that is about the event types (an invalid request whose parameter is `enabled_events`); a refusal about another parameter, a limit, a permission, a server
    // error or a dropped connection does not show that an event can not be subscribed: not confirmable.
    const eventTypesRefused = isEventTypeRefusal(error)
    const observed = { pinnedApiVersion: pinned, answer: eventTypesRefused ? 'event_types_refused' : 'other_error', error: facts, eventsNamedByStripe: NEW_EVENTS.filter((event) => facts.message.includes(event)) }
    return eventTypesRefused ? bad('T13', observed, 'Stripe refused the event types of the endpoint (an invalid request about enabled_events): at least one of them can not be subscribed.')
      : unknown('T13', observed, 'The endpoint could not be created, and the answer does not show that an event type is the cause (a refusal about another parameter, a limit, a permission, a server error or a dropped connection proves nothing about the events).')
  }
}

// ---- T14, T16: only with a test payment method YOU name ---------------------------------------------------------------------------------------------------------
async function refundStates(ctx: Ctx): Promise<FactResult[]> {
  const out: FactResult[] = []
  if (!ctx.options.refundTestPm) {
    for (const id of ['T14', 'T16']) if (wanted(ctx, id)) out.push(unknown(id, { testPaymentMethod: null }, 'No documented test payment method was given (--refund-test-pm): the code stays conservative.'))
    return out
  }
  const pi = await payTestIntent(ctx, 'T14', ctx.options.refundTestPm)
  if (pi.status !== 'succeeded') return ['T14', 'T16'].filter((id) => wanted(ctx, id)).map((id) => unknown(id, { paymentIntentStatus: pi.status }, 'The payment with that test method did not succeed.'))
  const opId = randomUUID()
  const refundAmount = 20
  const refund: any = await ctx.gate.call('refunds.create', () => ctx.gate.stripe.refunds.create({ payment_intent: pi.id, amount: refundAmount, metadata: tag(ctx, 'T14', { makerworksOperationId: opId }) }, { idempotencyKey: `makerworks:refund-op:${opId}`, timeout: BUDGET.perCallTimeoutMs }), { creates: 'refund' })
  track(ctx, 'refund', refund.id, 'T14', 'none (a refund can not be deleted)')
  // The refund is read again and again. Every round reads FIRST the amount refunded of the payment and THEN the state of the refund. The state read at the end of the round before (in the
  // first round: the one in the answer that created the refund) and the state read right after the amount BRACKET the amount: a sample is used by T16 only when the two are the same
  // state, so an amount is never paired with a state the refund was not in while the amount was read. (T14 only needs the states, in the order they were seen.)
  const states: string[] = [refund.status]
  const samples: RefundSample[] = []
  let previous: string = String(refund.status)
  for (let i = 0; i < BUDGET.maxPollAttempts; i++) {
    const charge: any = chargeOf(await readIntent(ctx, pi.id))
    const amountRefunded: number | null = charge?.amount_refunded ?? null
    const read: any = await ctx.gate.call('refunds.retrieve', () => ctx.gate.stripe.refunds.retrieve(refund.id, {}, { timeout: BUDGET.perCallTimeoutMs }))
    const statusAfter = String(read.status)
    const sample: RefundSample = { poll: i, statusBefore: previous, amountRefunded, statusAfter, stable: previous === statusAfter }
    samples.push(sample)
    if (states[states.length - 1] !== read.status) states.push(read.status)
    previous = statusAfter
    if (sample.stable && REFUND_ENDED.includes(sample.statusBefore)) break
    await ctx.deps.sleep(BUDGET.pollIntervalMs)
  }
  if (wanted(ctx, 'T14')) out.push(t14Result(states))
  if (wanted(ctx, 'T16')) out.push(t16Result(samples, states, refundAmount))
  return out
}

// ---- T16: what was SEEN decides, not what was assumed ----------------------------------------------------------------------------------------------------------------
// The question has two halves: is a refund that is still pending / requires_action counted in `amount_refunded`, and does the amount go back down when the refund fails or is canceled?
// To answer, both moments must have been caught, each with the amount read at that moment (a stable sample, see above). If either is missing the fact is NOT confirmable - it never
// says "confirmed" about a state it did not observe - and the half that was seen is still reported. It is a measurement: it is never "contradicted".
export type RefundSample = { poll: number; statusBefore: string; amountRefunded: number | null; statusAfter: string; stable: boolean }
const REFUND_OPEN = ['pending', 'requires_action']
const REFUND_FAILED = ['failed', 'canceled']
const REFUND_ENDED = ['succeeded', 'failed', 'canceled']

// ---- T14: the refund states, judged by what they SHOWED ------------------------------------------------------------------------------------------------------------------
// The fact is about the states a refund can be in besides `succeeded`: OPEN (pending, requires_action: "not refunded yet") and the two ways it can END WITHOUT refunding (failed, canceled).
// ONE refund goes through some of them, never all of them - `failed` and `canceled` are alternative ends - so the fact does not ask a single refund for an unrealistic sequence: it is confirmed
// by what a single refund can show, an open state AND an unsuccessful end, with nothing outside the five states the code knows. Every state is listed as observed or NOT observed; a state that
// nobody produced is never counted, whatever the code assumes about it.
export function t14Result(states: string[]): FactResult {
  const beyond = [...REFUND_OPEN, ...REFUND_FAILED]
  const unknownStates = [...new Set(states.filter((state) => state !== 'succeeded' && !beyond.includes(state)))]
  const statesObserved = beyond.filter((state) => states.includes(state))
  const statesNotObserved = beyond.filter((state) => !states.includes(state))
  const open = REFUND_OPEN.filter((state) => states.includes(state))
  const ended = REFUND_FAILED.filter((state) => states.includes(state))
  const observed = { statesInOrder: states, finalState: states[states.length - 1], unknownStates, statesObserved, statesNotObserved }
  const parts: FactPart[] = [
    {
      part: 'only_known_states', status: unknownStates.length === 0 ? 'confirmed' : 'contradicted',
      detail: unknownStates.length === 0 ? 'Every state seen is one of the five that the code knows.' : `A refund state that the code does not know was observed: ${unknownStates.join(', ')}.`,
    },
    {
      part: 'open_state_seen', status: open.length > 0 ? 'confirmed' : 'not_confirmable',
      detail: open.length > 0 ? `A refund was seen ${open.join(' and ')} ("not refunded yet").` : 'No refund was seen pending or requires_action: that kind of state was not produced, so nothing is confirmed about it.',
    },
    {
      part: 'unsuccessful_end_seen', status: ended.length > 0 ? 'confirmed' : 'not_confirmable',
      detail: ended.length > 0 ? `A refund was seen to end ${ended.join(' and ')}: it did not refund.` : 'No refund was seen failed or canceled (they are alternatives: one refund ends one way): that kind of end was not produced, so nothing is confirmed about it.',
    },
  ]
  const note = `${partsSummary(parts)} States observed: ${statesObserved.join(', ') || 'none'}. States NOT observed: ${statesNotObserved.join(', ') || 'none'} - they are not confirmed, whatever the code assumes about them. In the order seen: ${states.join(' -> ') || 'none'}.`
  return withParts('T14', parts, observed, note)
}
function t16Result(samples: RefundSample[], states: string[], refundAmountCents: number): FactResult {
  const usable = samples.filter((sample) => sample.stable && sample.amountRefunded !== null)
  const whilePending = usable.find((sample) => REFUND_OPEN.includes(sample.statusBefore))
  const afterFailure = usable.find((sample) => REFUND_FAILED.includes(sample.statusBefore))
  const afterSuccess = usable.find((sample) => sample.statusBefore === 'succeeded')
  const counted = whilePending ? (whilePending.amountRefunded === refundAmountCents ? true : whilePending.amountRefunded === 0 ? false : `other:${whilePending.amountRefunded}`) : null
  const missing = [...(whilePending ? [] : ['pending_or_requires_action']), ...(afterFailure ? [] : ['failed_or_canceled'])]
  const observed = {
    statesInOrder: states,
    samples: samples.map(({ poll, statusBefore, statusAfter, stable, amountRefunded }) => ({ poll, statusBefore, statusAfter, stable, amountRefunded })),
    pendingRefundCountedInAmountRefunded: counted,
    amountWhilePending: whilePending?.amountRefunded ?? null,
    amountAfterFailure: afterFailure?.amountRefunded ?? null,
    amountAfterSuccess: afterSuccess?.amountRefunded ?? null,
    wentBackDown: whilePending && afterFailure ? (afterFailure.amountRefunded as number) < (whilePending.amountRefunded as number) : null,
    missing,
  }
  const parts: FactPart[] = [
    {
      part: 'pending_or_requires_action', status: whilePending ? 'confirmed' : 'not_confirmable',
      detail: whilePending ? `The refund was caught ${whilePending.statusBefore} (same state before and after the amount was read): amount_refunded was ${whilePending.amountRefunded}.`
        : 'No moment was caught in which the refund was pending or requires_action with the same state read before and after the amount.',
    },
    {
      part: 'failed_or_canceled', status: afterFailure ? 'confirmed' : 'not_confirmable',
      detail: afterFailure ? `The refund was caught ${afterFailure.statusBefore} (same state before and after the amount was read): amount_refunded was ${afterFailure.amountRefunded}.`
        : 'No moment was caught in which the refund was failed or canceled with the same state read before and after the amount.',
    },
  ]
  const note = whilePending && afterFailure
    ? `Measured: while the refund was ${whilePending.statusBefore}, amount_refunded was ${whilePending.amountRefunded} (${counted === true ? 'a pending refund is counted' : counted === false ? 'a pending refund is not counted' : 'an amount that is neither 0 nor the refund'}); once it was ${afterFailure.statusBefore} it was ${afterFailure.amountRefunded}${observed.wentBackDown ? ' (it went back down)' : ' (it did not go down)'}.`
    : `Not confirmable: ${missing.join(' and ')} not caught. ${whilePending ? 'Seen: a pending refund and the amount at that moment.' : 'A pending refund was not seen.'} ${afterFailure ? 'Seen: a failed or canceled refund and the amount at that moment.' : 'A failed or canceled refund was not seen.'} The code stays conservative: it waits for the final state.`
  return withParts('T16', parts, observed, note)
}

// ---- clean-up and T18 -------------------------------------------------------------------------------------------------------------------------------------------
function setOutcome(ctx: Ctx, id: string, outcome: CleanupOutcome) {
  const entry = ctx.objects.find((object) => object.id === id)
  if (entry) entry.cleanup.outcome = outcome
}
async function cleanup(ctx: Ctx): Promise<FactResult> {
  const table: Array<Record<string, unknown>> = []
  let mismatches = 0
  for (const object of ctx.objects) {
    if (object.type === 'payment_intent' && object.cleanup.outcome === 'remains') {
      // an unpaid PaymentIntent can be canceled; a succeeded one can not (and is not tried)
      try {
        const read: any = await readIntent(ctx, object.id, [])
        if (read.status !== 'succeeded' && read.status !== 'canceled') {
          await ctx.gate.call('paymentIntents.cancel', () => ctx.gate.stripe.paymentIntents.cancel(object.id, {}, { timeout: BUDGET.perCallTimeoutMs }))
          object.cleanup = { action: 'cancel', outcome: 'canceled' }
        } else if (read.status === 'canceled') object.cleanup = { action: 'none', outcome: 'canceled' }
      } catch (error) { stopOnOwnStop(error); object.cleanup.error = errorFacts(error) }
    }
    const expected: Record<string, CleanupOutcome[]> = {
      checkout_session: ['expired', 'remains'], payment_intent: ['remains', 'canceled'], refund: ['remains'], webhook_endpoint: ['deleted', 'remains'],
    }
    if (!(expected[object.type] ?? ['remains']).includes(object.cleanup.outcome)) mismatches++
    table.push({ type: object.type, id: object.id, step: object.step, action: object.cleanup.action, outcome: object.cleanup.outcome, ...(object.cleanup.error ? { error: object.cleanup.error } : {}) })
  }
  const observed = { objects: table.length, outcomes: [...new Set(table.map((row) => row.outcome))].sort(), unexpected: mismatches }
  return mismatches === 0 ? ok('T18', observed, 'Succeeded payments, refunds and disputes remain in the history of Stripe: see the table in the guide.') : bad('T18', observed, 'An object ended in a state the guide does not expect.')
}

export type Report = {
  tool: string; version: number; runId: string; startedAt: string; finishedAt: string; aborted: string | null; livemodeSeen: boolean
  sdk: { pinnedApiVersion: string | null }
  budget: typeof BUDGET
  usage: { apiCalls: number; created: Record<ObjectKind, number>; amountCents: number; elapsedMs: number }
  facts: FactResult[]
  objects: CreatedObject[]
  calls: CallLog[]
  summary: Record<FactStatus, number>
}

export async function run(client: VerifyStripe, options: Options, deps: Deps): Promise<Report> {
  const startedAt = new Date(deps.now()).toISOString()
  const gate = new Gate(client, deps.now)
  const ctx: Ctx = { gate, options, deps, runId: options.runId, objects: [], state: {} }
  const results = new Map<string, FactResult>()
  let aborted: string | null = null
  let livemode = false
  const put = (list: FactResult[] | FactResult) => { for (const result of Array.isArray(list) ? list : [list]) results.set(result.id, result) }
  // The ONE place that decides what a stop of the script itself means (see `stopOnOwnStop`): a live-mode object -> aborted "livemode"; a maximum reached -> aborted "budget: ...". Once the run is
  // aborted every later step is skipped - including the clean-up - so nothing more is called; the facts not answered say that the run stopped, and the objects already created are in the report.
  const attempt = async (ids: string[], work: () => Promise<FactResult[] | FactResult>) => {
    if (aborted || !ids.some((id) => wanted(ctx, id))) return
    try { put(await work()) } catch (error) {
      if (error instanceof LivemodeError) { livemode = true; aborted = 'livemode'; return }
      if (error instanceof BudgetError) { aborted = `budget: ${error.message}`; return }
      const facts = errorFacts(error)
      for (const id of ids) if (wanted(ctx, id) && !results.has(id)) put(unknown(id, { error: facts }, 'The step failed before the question could be answered (permission, network or an unexpected answer).'))
    }
  }
  await attempt(['T1'], () => t1(ctx))
  await attempt(['T2'], () => t2(ctx))
  await attempt(['T3', 'T4', 'T5', 'T15', 'T17'], () => refundFacts(ctx))
  await attempt(['T7', 'T8', 'T9', 'T10', 'T11'], () => disputeFacts(ctx))
  await attempt(['T12'], () => t12(ctx))
  await attempt(['T13'], () => t13(ctx))
  await attempt(['T14', 'T16'], () => refundStates(ctx))
  if (wanted(ctx, 'T6')) put(unknown('T6', { reproducible: false }, 'The 24-hour retention of idempotency keys can not be reproduced in one run (by construction).'))
  if (!livemode) await attempt(['T18'], () => cleanup(ctx))
  // what was not answered because the run stopped
  for (const fact of FACTS) if (wanted(ctx, fact.id) && !results.has(fact.id)) put(unknown(fact.id, { reason: aborted ?? 'not reached' }, aborted ? `The run stopped (${aborted}) before this question.` : 'Not reached.'))
  const facts = FACTS.map((fact) => results.get(fact.id)).filter((result): result is FactResult => Boolean(result))
  const summary: Record<FactStatus, number> = { confirmed: 0, contradicted: 0, not_confirmable: 0 }
  for (const fact of facts) summary[fact.status]++
  return {
    tool: 'stripe-test-mode-verify', version: 1, runId: options.runId, startedAt, finishedAt: new Date(deps.now()).toISOString(), aborted, livemodeSeen: livemode,
    sdk: { pinnedApiVersion: (Stripe as unknown as { API_VERSION?: string }).API_VERSION ?? null },
    budget: BUDGET,
    usage: { apiCalls: gate.calls.length, created: { ...gate.created }, amountCents: gate.amountCents, elapsedMs: gate.elapsedMs },
    facts, objects: ctx.objects, calls: gate.calls, summary,
  }
}

// =====================================================================================================================================================================
// The plan (for --dry-run) and the command line
// =====================================================================================================================================================================
export function planLines(options: Options): string[] {
  const lines: string[] = []
  lines.push('DRY RUN - nothing is sent to Stripe. This is what a real run would do, in TEST MODE only:')
  lines.push('')
  lines.push(`  run id: ${options.runId}   currency: ${options.currency}   tag on every object: metadata.makerworksVerify=${options.runId}`)
  lines.push('')
  lines.push('  Facts that would be asked (each answered confirmed / contradicted / not confirmable):')
  for (const fact of FACTS) lines.push(`    ${fact.id.padEnd(3)} ${fact.title}`)
  lines.push('')
  lines.push('  Declared maxima - the run stops before going over any of them:')
  lines.push(`    money: at most ${(BUDGET.maxAmountCentsPerPayment / 100).toFixed(2)} per payment and ${(BUDGET.maxAmountCentsTotal / 100).toFixed(2)} ${options.currency.toUpperCase()} in total (test money)`)
  lines.push(`    Checkout Sessions: ${BUDGET.checkoutSessions}   PaymentIntents: ${BUDGET.paymentIntents}   refunds: ${BUDGET.refunds}   dispute evidence submissions: ${BUDGET.disputeEvidenceSubmissions}   webhook endpoints: ${BUDGET.webhookEndpoints} (deleted at once)`)
  lines.push(`    never created: customers, products, prices, invoices, payment links`)
  lines.push(`    API calls: at most ${BUDGET.maxApiCalls}   duration: at most ${Math.round(BUDGET.maxRunMs / 60000)} minutes   no automatic retry of any call`)
  lines.push('')
  lines.push('  What stays in Stripe afterwards (it can not be deleted): paid test payments and their charges, refunds, disputes, balance transactions and events.')
  lines.push('  Only these are cleaned up: an open payment page (expired), an unpaid PaymentIntent (canceled), the throw-away webhook endpoint (deleted).')
  lines.push('')
  lines.push(`  guided step T2: ${options.skipGuided ? 'SKIPPED (--skip-guided)' : 'you will be asked to pay one test page with a Stripe test card'}`)
  lines.push(`  T14 / T16: ${options.refundTestPm ? `with the test payment method you named (${options.refundTestPm})` : 'not asked (no --refund-test-pm)'}`)
  return lines
}

export type MainDeps = Partial<Deps> & { createClient?: (key: string) => VerifyStripe; repoRoot?: string; writeReport?: (file: string, content: string) => void; mkdir?: (dir: string) => void }
function defaultPrompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer) }))
}
export function createRealClient(secret: string): VerifyStripe {
  // no automatic retry: a repeated call would be a call nobody asked for
  return new Stripe(secret, { apiVersion: Stripe.API_VERSION as Stripe.LatestApiVersion, maxNetworkRetries: 0, timeout: BUDGET.perCallTimeoutMs, typescript: true })
}

export async function main(argv: string[], env: Record<string, string | undefined>, deps: MainDeps = {}): Promise<number> {
  const say = deps.say ?? ((line: string) => console.log(redact(line, env.STRIPE_SECRET_KEY)))
  const parsed = parseArgs(argv)
  if ('error' in parsed) { say(`Cannot start: ${parsed.error}`); return 2 }
  const { options } = parsed
  const secret = env.STRIPE_SECRET_KEY
  // a key that is not a test key is refused even for a dry run: a mistake is caught before anything else
  if (secret) { const problem = refuseKey(secret); if (problem) { say(`Cannot start: ${problem}`); return 2 } }
  if (options.dryRun) { for (const line of planLines(options)) say(line); return 0 }
  const problem = refuseKey(secret)
  if (problem) { say(`Cannot start: ${problem}`); return 2 }
  const repoRoot = deps.repoRoot ?? process.cwd()
  const folderProblem = refuseReportDir(options.reportDir, repoRoot)
  if (folderProblem) { say(`Cannot start: ${folderProblem}`); return 2 }
  const prompt = deps.prompt ?? defaultPrompt
  for (const line of planLines({ ...options, dryRun: false }).slice(1)) say(line)
  if (!options.yes) {
    const answer = (await prompt('\nThis creates the TEST objects described above in your Stripe TEST account. Type YES to go on: ')).trim()
    if (answer !== 'YES') { say('Nothing was done.'); return 2 }
  }
  const client = (deps.createClient ?? createRealClient)(secret as string)
  const runDeps: Deps = { sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), now: deps.now ?? Date.now, prompt, say }
  let report: Report
  try { report = await run(client, options, runDeps) } catch (error) { say(`The run failed: ${redact(String((error as Error)?.message ?? error), secret)}`); return 1 }
  const json = JSON.stringify(report, null, 2)
  try { assertCleanReport(json, secret) } catch (error) { say(`The report was NOT written: ${(error as Error).message}`); return 1 }
  const dir = path.resolve(options.reportDir as string)
  ;(deps.mkdir ?? ((target: string) => fs.mkdirSync(target, { recursive: true, mode: 0o700 })))(dir)
  const file = path.join(dir, `stripe-test-mode-verify-${options.runId}.json`)
  ;(deps.writeReport ?? ((target: string, content: string) => fs.writeFileSync(target, content, { mode: 0o600 })))(file, json)
  say('')
  say(`Done. Confirmed: ${report.summary.confirmed}   contradicted: ${report.summary.contradicted}   not confirmable: ${report.summary.not_confirmable}${report.aborted ? `   (the run stopped early: ${report.aborted})` : ''}`)
  say(`The report is in ${file} (readable only by you). Send me that file and nothing else.`)
  say(`Test objects created (all tagged ${options.runId}): ${report.objects.length}. They are listed in the report; the guide says which ones stay in Stripe.`)
  return report.aborted === 'livemode' ? 3 : 0
}

if (process.argv[1] && /stripe-test-mode-verify\.[cm]?[jt]s$/.test(process.argv[1])) {
  main(process.argv.slice(2), { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY })
    .then((code) => { process.exitCode = code })
    .catch((error) => { console.error(redact(String((error as Error)?.message ?? error), process.env.STRIPE_SECRET_KEY)); process.exitCode = 1 })
}
