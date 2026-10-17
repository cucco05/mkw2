// The journal of effects on OUTSIDE services whose outcome can be unknown (step 4.6, S4): a job sent to PrintLab, a movement written to StockWorks.
// Pure functions: no database, no network. The order's `metadata.externalEffects` is the record; lib/production-release.ts and the two services' modules
// read and write it under the lock on the order.
//
// The problem. A request can end in a way that does not say whether the other side did anything: the answer is lost, the connection drops after the request left,
// the call times out, the service answers 500 after having done the work. Sending again could make a second print or take the material out of stock twice.
// So, for every effect:
//   1. an INTENT is written (durably, under the lock) BEFORE the call. A process that dies mid-call leaves it behind;
//   2. the call is made, and its end is CLASSIFIED:
//        not_sent   the request never left (connection refused, name not found...): nothing happened, trying again is safe;
//        rejected   the service answered that it refused (4xx): it did nothing, trying again is safe once the cause is fixed;
//        confirmed  the service answered with the record it made;
//        uncertain  anything else (timeout, reset, 5xx, an answer that is not a record, a conflict): the service MAY have done it;
//   3. an intent that never got an outcome (dead process, claim expired) IS `uncertain`;
//   4. from `uncertain` there is NO automatic way back to "send again", and the expiry of a claim does not change that. It ends only with PROOF that the effect
//      exists: the record is found on the outside service (reconciliation by presence), or an administrator names a record that the SERVER then verifies on
//      the outside service. The ABSENCE of a record in a search proves nothing (the service may lag, may not list it, may be unreachable), and an administrator's
//      declaration that "it did not happen" is not proof either. Without proof the effect stays uncertain and is reported;
//   5. we do not claim "exactly once": the guarantee is "at most one attempt per intent, never repeated while the outcome is unknown".
//
// An order whose metadata is gone altogether (`metadata` NULL: the account was erased, lib/privacy.ts) has lost its history: every effect on it starts uncertain.
import { randomUUID } from 'node:crypto'

export type ExternalEffectKind = 'printlab_submit' | 'stockworks_movement'
export type ExternalEffectState = 'intent' | 'confirmed' | 'rejected' | 'not_sent' | 'uncertain'
export type ConfirmedBy = 'response' | 'reconciliation' | 'admin_proof'

export type ExternalEffectRecord = {
  kind: ExternalEffectKind
  state: ExternalEffectState
  intentId: string
  attempts: number
  startedAt: string
  // while `intent`: until when the claim keeps another process away
  claimUntil: string | null
  by: string
  adminId: string | null
  // what identifies the effect on the outside service (idempotency key, item, inventory line, reference...) - what a reconciliation looks for
  detail: Record<string, unknown>
  externalId: string | null
  confirmedBy: ConfirmedBy | null
  cause: string | null
  httpStatus: number | null
  message: string | null
  at: string
  // the effect finished after the order had been blocked: kept visible, nothing is undone automatically
  blockedAfterSend: boolean
}

export const EXTERNAL_EFFECTS_KEY = 'externalEffects'
// How long an intent protects itself. A process that is still working renews it before each call.
export const INTENT_CLAIM_TTL_MS = 5 * 60 * 1000

type Json = Record<string, unknown>
const asRecord = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})
const STATES: readonly string[] = ['intent', 'confirmed', 'rejected', 'not_sent', 'uncertain']
const KINDS: readonly string[] = ['printlab_submit', 'stockworks_movement']

export function readJournal(metadata: unknown): Record<string, ExternalEffectRecord> {
  const raw = asRecord(asRecord(metadata)[EXTERNAL_EFFECTS_KEY])
  const out: Record<string, ExternalEffectRecord> = {}
  for (const [key, value] of Object.entries(raw)) {
    const entry = asRecord(value)
    if (!KINDS.includes(String(entry.kind))) continue
    // A record whose state is unreadable is not "nothing": it is an effect we know nothing about.
    const state = (STATES.includes(String(entry.state)) ? entry.state : 'uncertain') as ExternalEffectState
    out[key] = {
      kind: entry.kind as ExternalEffectKind,
      state,
      intentId: typeof entry.intentId === 'string' ? entry.intentId : '',
      attempts: Number.isFinite(Number(entry.attempts)) ? Number(entry.attempts) : 1,
      startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : '',
      claimUntil: typeof entry.claimUntil === 'string' ? entry.claimUntil : null,
      by: typeof entry.by === 'string' ? entry.by : '',
      adminId: typeof entry.adminId === 'string' ? entry.adminId : null,
      detail: asRecord(entry.detail),
      externalId: typeof entry.externalId === 'string' ? entry.externalId : null,
      confirmedBy: entry.confirmedBy === 'response' || entry.confirmedBy === 'reconciliation' || entry.confirmedBy === 'admin_proof' ? entry.confirmedBy : null,
      cause: typeof entry.cause === 'string' ? entry.cause : (STATES.includes(String(entry.state)) ? null : 'unreadable_record'),
      httpStatus: Number.isFinite(Number(entry.httpStatus)) && entry.httpStatus !== null ? Number(entry.httpStatus) : null,
      message: typeof entry.message === 'string' ? entry.message : null,
      at: typeof entry.at === 'string' ? entry.at : '',
      blockedAfterSend: entry.blockedAfterSend === true,
    }
  }
  return out
}

function withJournal(metadata: unknown, journal: Record<string, ExternalEffectRecord>): Json {
  return { ...asRecord(metadata), [EXTERNAL_EFFECTS_KEY]: journal }
}

export type BeginRequest = { key: string; kind: ExternalEffectKind; by: string; adminId: string | null; detail: Record<string, unknown> }
export type BeginVerdict =
  | 'proceed'          // an intent was written: make the call
  | 'already_done'     // confirmed earlier: do not call again
  | 'in_progress'      // another process holds a live intent
  | 'unknown_outcome'  // the outcome of an earlier attempt is not known: do not call; reconcile or report
export type BeginResult = { metadata: Json; verdicts: Record<string, { verdict: BeginVerdict; record: ExternalEffectRecord }> }

// Decides, for each effect an operation wants to make, whether it may go ahead - and writes the intents of those that may. Called under the lock on the order.
// `metadataLost`: the order's metadata is NULL (erased): an effect with no record is then as good as unknown.
export function beginEffects(metadata: unknown, requests: readonly BeginRequest[], opts: { now?: number; metadataLost?: boolean } = {}): BeginResult {
  const now = opts.now ?? Date.now()
  const nowIso = new Date(now).toISOString()
  const journal = { ...readJournal(metadata) }
  const verdicts: BeginResult['verdicts'] = {}
  for (const request of requests) {
    const existing = journal[request.key]
    if (existing?.state === 'confirmed') { verdicts[request.key] = { verdict: 'already_done', record: existing }; continue }
    if (existing?.state === 'intent') {
      const until = Date.parse(existing.claimUntil || '')
      if (Number.isFinite(until) && until > now) { verdicts[request.key] = { verdict: 'in_progress', record: existing }; continue }
      // the claim ran out and nobody reported back: the call may well have been made
      const converted: ExternalEffectRecord = { ...existing, state: 'uncertain', claimUntil: null, cause: 'claim_expired', message: 'The process that was making this call did not report back.', at: nowIso }
      journal[request.key] = converted
      verdicts[request.key] = { verdict: 'unknown_outcome', record: converted }
      continue
    }
    if (existing?.state === 'uncertain') { verdicts[request.key] = { verdict: 'unknown_outcome', record: existing }; continue }
    if (!existing && opts.metadataLost) {
      const lost: ExternalEffectRecord = {
        kind: request.kind, state: 'uncertain', intentId: randomUUID(), attempts: 0, startedAt: nowIso, claimUntil: null, by: request.by, adminId: request.adminId,
        detail: request.detail, externalId: null, confirmedBy: null, cause: 'metadata_lost', httpStatus: null,
        message: 'The order\'s metadata was erased, so whether this was already done is not known.', at: nowIso, blockedAfterSend: false,
      }
      journal[request.key] = lost
      verdicts[request.key] = { verdict: 'unknown_outcome', record: lost }
      continue
    }
    // nothing, or provably nothing happened (rejected / not_sent): a new intent
    const fresh: ExternalEffectRecord = {
      kind: request.kind, state: 'intent', intentId: randomUUID(), attempts: (existing?.attempts ?? 0) + 1, startedAt: nowIso, claimUntil: new Date(now + INTENT_CLAIM_TTL_MS).toISOString(),
      by: request.by, adminId: request.adminId, detail: request.detail, externalId: null, confirmedBy: null, cause: null, httpStatus: null, message: null, at: nowIso, blockedAfterSend: false,
    }
    journal[request.key] = fresh
    verdicts[request.key] = { verdict: 'proceed', record: fresh }
  }
  return { metadata: withJournal(metadata, journal), verdicts }
}

// Keeps a live intent alive (called before each call of a long operation). Only the intent that is ours, and still live, is renewed.
export function renewIntents(metadata: unknown, owned: ReadonlyArray<{ key: string; intentId: string }>, now = Date.now()): { metadata: Json; renewed: string[]; lost: string[] } {
  const journal = { ...readJournal(metadata) }
  const renewed: string[] = []
  const lost: string[] = []
  for (const { key, intentId } of owned) {
    const record = journal[key]
    if (record && record.state === 'intent' && record.intentId === intentId) {
      journal[key] = { ...record, claimUntil: new Date(now + INTENT_CLAIM_TTL_MS).toISOString() }
      renewed.push(key)
    } else lost.push(key)
  }
  return { metadata: withJournal(metadata, journal), renewed, lost }
}

export type EffectOutcome =
  | { state: 'confirmed'; externalId: string | null; confirmedBy?: ConfirmedBy; httpStatus?: number | null }
  | { state: 'rejected' | 'not_sent' | 'uncertain'; cause: string; message: string; httpStatus?: number | null }

// Writes the end of an attempt. It applies only to the attempt it belongs to (`intentId`): a record that another attempt replaced is left alone.
// A definite outcome overrides an `uncertain` that was only a lapsed claim: we now KNOW. An already CONFIRMED effect is never downgraded.
export function recordEffectOutcome(metadata: unknown, key: string, intentId: string, outcome: EffectOutcome, opts: { now?: number; blockedAfterSend?: boolean } = {}): { metadata: Json; applied: boolean } {
  const journal = { ...readJournal(metadata) }
  const record = journal[key]
  if (!record || record.intentId !== intentId || record.state === 'confirmed') return { metadata: withJournal(metadata, journal), applied: false }
  const at = new Date(opts.now ?? Date.now()).toISOString()
  const base = { ...record, claimUntil: null, at, blockedAfterSend: record.blockedAfterSend || opts.blockedAfterSend === true }
  journal[key] = outcome.state === 'confirmed'
    ? { ...base, state: 'confirmed', externalId: outcome.externalId, confirmedBy: outcome.confirmedBy ?? 'response', cause: null, httpStatus: outcome.httpStatus ?? null, message: null }
    : { ...base, state: outcome.state, cause: outcome.cause, message: outcome.message.slice(0, 300), httpStatus: outcome.httpStatus ?? null }
  return { metadata: withJournal(metadata, journal), applied: true }
}

// An effect found on the outside service (reconciliation) or proven by an administrator's record that the server verified: the way OUT of `uncertain`.
export function confirmEffectByProof(metadata: unknown, key: string, proof: { externalId: string; confirmedBy: Exclude<ConfirmedBy, 'response'>; adminId?: string | null; note?: string }, now = Date.now()): { metadata: Json; applied: boolean; before: ExternalEffectState | null } {
  const journal = { ...readJournal(metadata) }
  const record = journal[key]
  if (!record) return { metadata: withJournal(metadata, journal), applied: false, before: null }
  if (record.state === 'confirmed') return { metadata: withJournal(metadata, journal), applied: false, before: 'confirmed' }
  journal[key] = {
    ...record, state: 'confirmed', claimUntil: null, externalId: proof.externalId, confirmedBy: proof.confirmedBy, cause: null, httpStatus: record.httpStatus,
    message: proof.note ? proof.note.slice(0, 300) : record.message, at: new Date(now).toISOString(), adminId: proof.adminId ?? record.adminId,
  }
  return { metadata: withJournal(metadata, journal), applied: true, before: record.state }
}

// Does a call that started and has no outcome yet still hold its claim - i.e. may another request be making it right now?
export function claimIsLive(record: Pick<ExternalEffectRecord, 'state' | 'claimUntil'>, now = Date.now()) {
  return record.state === 'intent' && Date.parse(record.claimUntil || '') > now
}

export function unresolvedEffects(metadata: unknown): Array<{ key: string; record: ExternalEffectRecord }> {
  return Object.entries(readJournal(metadata)).filter(([, record]) => record.state === 'uncertain' || record.state === 'intent').map(([key, record]) => ({ key, record }))
}
export function hasUnresolvedEffect(metadata: unknown) {
  return unresolvedEffects(metadata).length > 0
}
// Anything that says an outside service may have been told about this order: used to keep an order that produced something from being deleted.
export function hasRecordedEffect(metadata: unknown) {
  return Object.values(readJournal(metadata)).some((record) => record.state !== 'rejected' && record.state !== 'not_sent')
}

// ---- classifying how a call ended -----------------------------------------------------------------------------------------------------
export type FailureClass = { state: 'not_sent' | 'rejected' | 'uncertain'; cause: string; message: string; httpStatus: number | null }

// Codes of a connection that was never established: the request did not leave.
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL'])

function causeChain(err: unknown): any[] {
  const chain: any[] = []
  let current: any = err
  for (let depth = 0; current && depth < 6; depth++) {
    chain.push(current)
    current = current.cause
  }
  return chain
}

// `err` is what the client threw. Network failures carry `networkFailure: true` and the original error as `cause` (lib/printlab.ts, lib/stockworks-client.ts);
// an answer of the service carries its HTTP status. Anything not recognised is UNCERTAIN: the safe reading is never "nothing happened".
export function classifyExternalFailure(err: unknown): FailureClass {
  const chain = causeChain(err)
  const top: any = chain[0] ?? {}
  const message = String(top?.message || err || 'The call failed').slice(0, 300)
  const code = chain.map((entry) => entry?.code).find((value) => typeof value === 'string') as string | undefined
  const names = chain.map((entry) => String(entry?.name || ''))
  if (code && NEVER_SENT_CODES.has(code)) return { state: 'not_sent', cause: code.toLowerCase(), message, httpStatus: null }
  // the HTTP client itself refuses to send to a forbidden port (before any connection is made)
  if (chain.some((entry) => /^bad port$/i.test(String(entry?.message || '')))) return { state: 'not_sent', cause: 'bad_port', message, httpStatus: null }
  if (names.some((name) => name === 'TimeoutError' || name === 'AbortError')) return { state: 'uncertain', cause: 'timeout', message, httpStatus: null }
  const status = Number(top?.status)
  const answered = top?.networkFailure !== true && Number.isFinite(status) && status >= 100 && status < 600 && (top?.payload !== undefined || top?.answered === true)
  if (answered) {
    if (status === 409 || status === 408) return { state: 'uncertain', cause: status === 409 ? 'conflict' : 'request_timeout', message, httpStatus: status }
    if (status >= 400 && status < 500) return { state: 'rejected', cause: `http_${status}`, message, httpStatus: status }
    return { state: 'uncertain', cause: status >= 500 ? 'server_error' : `http_${status}`, message, httpStatus: status }
  }
  if (code) return { state: 'uncertain', cause: 'connection_lost', message, httpStatus: null }
  return { state: 'uncertain', cause: top?.networkFailure ? 'connection_lost' : 'unknown_error', message, httpStatus: null }
}

// A 2xx that is not a record we can read (garbled body, empty body): the service may have done it.
export const BAD_RESPONSE: FailureClass = { state: 'uncertain', cause: 'bad_response', message: 'The service answered, but not with a readable record.', httpStatus: null }

// For the screens and the audit: one line per effect.
export function describeEffect(key: string, record: ExternalEffectRecord): string {
  const what = record.kind === 'printlab_submit' ? 'PrintLab job' : 'StockWorks movement'
  switch (record.state) {
    case 'confirmed': return `${what} ${key}: done${record.externalId ? ` (${record.externalId})` : ''}`
    case 'intent': return `${what} ${key}: being sent`
    case 'rejected': return `${what} ${key}: refused by the service (${record.cause ?? 'refused'})`
    case 'not_sent': return `${what} ${key}: not sent (${record.cause ?? 'not reached'})`
    default: return `${what} ${key}: OUTCOME UNKNOWN (${record.cause ?? 'unknown'}) - check the outside service before doing anything`
  }
}

// ---- has this order been sent to production? -----------------------------------------------------------------------------------------------
// Used to keep an order that has a job in production from being DELETED (the job would be left without an order) and to ask for a written reason before it is
// CANCELLED. It reads the journal, the older submission records (also written by the PrintLab link and callback) and the status. Nothing here ever sends a
// command to a printer: stopping a job is a person's decision in PrintLab.
const nonEmptyText = (value: unknown) => typeof value === 'string' && value.trim().length > 0
// The written reason that cancelling an order which already went to production needs (the status route and the order screen both read it from here).
export const CANCELLATION_REASON_MIN_LENGTH = 10
export function productionJobEvidence(order: { status?: string | null; metadata: unknown }): string[] {
  const evidence = new Set<string>()
  const metadata = asRecord(order.metadata)
  for (const record of Object.values(readJournal(metadata))) {
    if (record.kind === 'printlab_submit') {
      if (record.state === 'confirmed') evidence.add('printlab_job_confirmed')
      else if (record.state === 'uncertain' || record.state === 'intent') evidence.add('printlab_outcome_unknown')
    } else if (record.kind === 'stockworks_movement') {
      if (record.state === 'confirmed') evidence.add('material_consumed')
      else if (record.state === 'uncertain' || record.state === 'intent') evidence.add('material_outcome_unknown')
    }
  }
  const submissions = Array.isArray(metadata.printLabSubmissions) ? metadata.printLabSubmissions : []
  if (submissions.some((entry) => {
    const row = asRecord(entry)
    return nonEmptyText(row.printLabJobId) || nonEmptyText(row.jobId) || nonEmptyText(row.id) || nonEmptyText(row.successfulGcodeId)
  })) evidence.add('printlab_submission_recorded')
  if (nonEmptyText(metadata.stockworksConsumedAt)) evidence.add('material_consumed')
  const status = String(order.status || '')
  if (['printing', 'post_process', 'in_production', 'ready'].includes(status)) evidence.add('production_started')
  if (['shipped', 'completed'].includes(status)) evidence.add('production_finished')
  return [...evidence]
}
