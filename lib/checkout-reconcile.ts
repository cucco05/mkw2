// DR-13 / D10 — reconcile ONE payment attempt whose page nobody can name, on POSITIVE proof from the provider only (E-A).
//
// WHEN THIS IS NEEDED. A reservation (`creating`) whose request cannot be sent again safely (too old, the stored request is not the one that would be built now, no stored request), an
// attempt with no Stripe identifier that is waiting for a person (`open` without an identifier; a row the old code closed without any identifier) - the planner (lib/checkout-session-plan.ts)
// refuses to open anything next to them and the customer is told the page is "being checked", forever, because a page MAY exist at the provider that the database never learned about.
// What ends that is the provider NAMING the page. Nothing else: not the clock, not the age of the row, not the absence of a webhook, not the absence of the page from a listing.
//
// WHAT THIS DOES (and the only thing it does):
//   1. takes a session - given by the operator (copied from the provider's dashboard, a webhook, a receipt) or FOUND by looking through the sessions created in the window of the reservation
//      for ones whose metadata names this attempt;
//   2. READS it from the provider (`retrieve`: the state it has NOW, not what a listing or an earlier answer said);
//   3. checks that it is THE session of this attempt and of this order - its metadata names the attempt, its metadata and its client reference name the order, it is a payment-mode session,
//      its identifier is what the operator gave and has the shape of a session identifier - and that no other attempt already holds it;
//   4. writes it down and lets the SAME rules decide what it is (`applyKnownSession`, lib/checkout-sessions.ts: the planner under the lock of the order; an open page that must not stay open
//      is closed at the provider, with proof; a page the customer paid becomes a payment that the verified payment handling records - never marked paid here).
//
// WHAT THIS NEVER DOES. It never releases a reservation because nothing was found (that is "E-B": the absence of a page from a listing proves nothing - the listing may lag, may be incomplete,
// may not be filterable the way we need - and it is NOT implemented, not behind a flag either: `discover` that finds nothing changes nothing and says so). It never deletes or edits a row by
// hand, never sends a request to create a page, never opens or hands out a page, never moves money, never marks an order paid, and never acts without an administrator named in the call.
//
// GUARANTEES. Dry-run is the default of the command and a parameter of the function (no default here): a dry-run writes NOTHING (it reads rows, and reads the session from the provider) and records
// no audit event. An apply is audited BEFORE it acts (the request, with the operator and the checks) and after it (what happened); if the first record cannot be written nothing is done.
// Every write goes through the settlement of the order (one transaction under the lock of the order, conditional updates), so running it twice, or beside a customer's request, ends in the same
// place: the second run changes nothing and says `already_done`. Any error, ambiguity or unexpected state ends in `refused` with a code and leaves the rows as they are.
import type Stripe from 'stripe'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { recordAdminAuditEvent } from '@/lib/admin-audit'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'
import { applyKnownSession } from '@/lib/checkout-sessions'
import { hasLivePageOfUnpayableOrder, pageJobsSettled } from '@/lib/checkout-pages'
import { classifySessionStatus, isSessionId } from '@/lib/checkout-session-plan'

export const RECONCILE_AUDIT_REQUESTED = 'checkout.page.reconcile.requested'
export const RECONCILE_AUDIT_FINISHED = 'checkout.page.reconcile.finished'

const STRIPE_READ_TIMEOUT_MS = 15_000
// The sessions of a reservation are made when it is made (or by a replay in the minute and a half that follows): the window is generous both ways, and bounded.
const DISCOVERY_BEFORE_MS = 10 * 60_000
const DISCOVERY_AFTER_MS = 15 * 60_000
const DISCOVERY_PAGE_SIZE = 100
export const DISCOVERY_MAX_PAGES = 10

export type ReconcileCode =
  | 'ok' | 'dry_run' | 'unchanged'
  | 'OPERATOR_NOT_AUTHORIZED' | 'ATTEMPT_NOT_FOUND' | 'NOT_RECONCILABLE' | 'NO_SESSION_GIVEN' | 'SESSION_ID_INVALID' | 'SESSION_CONFLICT' | 'PROVIDER_UNAVAILABLE'
  | 'SESSION_NOT_IDENTIFIED' | 'UNKNOWN_PROVIDER_STATE' | 'AMBIGUOUS_EVIDENCE' | 'NO_EVIDENCE' | 'AUDIT_UNAVAILABLE' | 'APPLY_FAILED' | 'PAGE_NOT_CLOSED'

export type AttemptView = { status: string; stripeSessionId: string | null; failureReason: string | null }
export type OrderView = { status: string; paymentStatus: string; paymentReviewReason: string | null }
export type Discovery = { windowFrom: number; windowTo: number; pages: number; requests: number; examined: number; matches: string[]; complete: boolean }
export type Reconciliation = {
  // planned: dry run · applied: done · partial: something was committed and something is left to do (run again) · already_done: nothing to change · refused / no_evidence: nothing was changed
  outcome: 'planned' | 'applied' | 'partial' | 'already_done' | 'refused' | 'no_evidence'
  code: ReconcileCode
  message: string
  dryRun: boolean
  attemptId: string
  orderId: string | null
  sessionId: string | null
  provider: { status: string | null; paymentStatus: string | null } | null
  checks: Identification['checks'] | null
  actions: string[]
  before: { attempt: AttemptView; order: OrderView } | null
  after: { attempt: AttemptView; order: OrderView } | null
  discovery: Discovery | null
  endedAs: string | null
}

// ---- who may ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// An administrator (not staff, like the decision about a payment on hold), who exists and is not suspended. The caller names the person; nothing here reads a cookie.
async function authorizeOperator(operatorId: string) {
  if (!operatorId) return null
  const user = await prisma.user.findUnique({ where: { id: operatorId }, select: { id: true, email: true, isAdmin: true, role: true, isSuspended: true } })
  if (!user || user.isSuspended) return null
  return user.isAdmin || user.role === 'admin' ? user : null
}

// ---- is it THE session of this attempt? ------------------------------------------------------------------------------------------------------------------------------------------
// PURE. Every check must hold; none is a hint. (Amount and currency are NOT checks of identity: a page whose amount no longer matches the order is still that attempt's page - and the
// settlement closes it at the provider, with proof, because it must not stay open.)
export type Identification = {
  ok: boolean
  checks: { shape: boolean; sameId: boolean; paymentMode: boolean; namesAttempt: boolean; namesOrder: boolean; clientReference: boolean }
}
export function identifySession(input: { attemptId: string; orderId: string; sessionId: string; session: Pick<Stripe.Checkout.Session, 'id' | 'mode' | 'metadata' | 'client_reference_id'> }): Identification {
  const { attemptId, orderId, sessionId, session } = input
  const checks = {
    shape: isSessionId(sessionId),
    sameId: session.id === sessionId,
    paymentMode: session.mode === 'payment',
    namesAttempt: typeof attemptId === 'string' && attemptId.length > 0 && session.metadata?.attemptId === attemptId,
    namesOrder: typeof orderId === 'string' && orderId.length > 0 && session.metadata?.orderId === orderId,
    clientReference: session.client_reference_id === orderId,
  }
  return { ok: Object.values(checks).every(Boolean), checks }
}

// ---- finding a session by looking: POSITIVE matches only --------------------------------------------------------------------------------------------------------------------
// Looks through the sessions created around the reservation and keeps the ones whose metadata names this attempt. A match is a lead that is then read and identified like any session;
// "no match" - or an incomplete listing - is NOT evidence of anything: the caller changes nothing. Bounded (DISCOVERY_MAX_PAGES pages); an error is thrown to the caller, who refuses.
export async function discoverSessions(attempt: { id: string; createdAt: Date }): Promise<Discovery> {
  const windowFrom = Math.floor((attempt.createdAt.getTime() - DISCOVERY_BEFORE_MS) / 1000)
  const windowTo = Math.ceil((attempt.createdAt.getTime() + DISCOVERY_AFTER_MS) / 1000)
  const seen = new Set<string>()
  const matches = new Set<string>()
  let startingAfter: string | undefined
  let pages = 0
  let complete = false
  while (pages < DISCOVERY_MAX_PAGES) {
    const page = await getStripe().checkout.sessions.list(
      { created: { gte: windowFrom, lte: windowTo }, limit: DISCOVERY_PAGE_SIZE, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { timeout: STRIPE_READ_TIMEOUT_MS },
    )
    pages += 1
    for (const session of page.data ?? []) {
      seen.add(session.id)
      if (session.metadata?.attemptId === attempt.id) matches.add(session.id)
    }
    const last = page.data?.[page.data.length - 1]
    if (!page.has_more) { complete = true; break }
    if (!last) break
    startingAfter = last.id
  }
  return { windowFrom, windowTo, pages, requests: pages, examined: seen.size, matches: [...matches].sort(), complete }
}

// ---- the operation ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type ReconcileInput = {
  attemptId: string
  /** the session to reconcile with: copied from the provider by the operator */
  sessionId?: string | null
  /** look for it among the sessions created in the window of the reservation (positive matches only) */
  discover?: boolean
  operatorId: string
  /** required, no default: a dry-run writes nothing and records no audit event */
  dryRun: boolean
  channel?: { requestMethod: string; requestPath: string }
}

const FINAL_STATES = ['paid', 'processing', 'mismatch']

const viewOf = (a: { status: string; stripeSessionId: string | null; failureReason: string | null }): AttemptView => ({ status: a.status, stripeSessionId: a.stripeSessionId, failureReason: a.failureReason })
const orderViewOf = (o: { status: string; paymentStatus: string; paymentReviewReason: string | null }): OrderView => ({ status: o.status, paymentStatus: o.paymentStatus, paymentReviewReason: o.paymentReviewReason })
const sameView = (a: { attempt: AttemptView; order: OrderView }, b: { attempt: AttemptView; order: OrderView }) => JSON.stringify(a) === JSON.stringify(b)

async function snapshot(attemptId: string) {
  const attempt = await prisma.paymentAttempt.findUnique({ where: { id: attemptId }, include: { order: { select: { id: true, status: true, paymentStatus: true, paymentReviewReason: true } } } })
  return attempt
}

// what the provider's word will lead to, in plain words (the same rules as the customer's own request: the planner under the lock of the order)
function plannedActions(attempt: { stripeSessionId: string | null; status: string }, sessionId: string, state: ReturnType<typeof classifySessionStatus>): string[] {
  const actions: string[] = []
  if (!attempt.stripeSessionId) actions.push(`write the identifier ${sessionId} on the attempt (nothing else is written for this step)`)
  else actions.push(`the identifier ${sessionId} is already on the attempt: the settlement is run again (every write is conditional: it changes only what is not yet as the provider shows it)`)
  if (state === 'open') actions.push('settle: if the order can still be paid and this is its only live page, the attempt becomes the open page of the order (the customer\'s next request reuses it); otherwise the page is closed at the provider and the proof is written on the row')
  else if (state === 'complete') actions.push('settle: the customer finished paying - the attempt becomes "processing" (the order\'s financial revision goes up) and the payment is handed to the verified payment handling; this never marks the order paid')
  else if (state === 'closed') actions.push('settle: the provider shows the page expired - the proof (provider_status:expired) is written on the row, which keeps its identifier')
  return actions
}

export async function reconcileAttempt(input: ReconcileInput): Promise<Reconciliation> {
  const dryRun = input.dryRun !== false
  const channel = input.channel ?? { requestMethod: 'CLI', requestPath: 'scripts/checkout-reconcile.ts' }
  const base: Reconciliation = {
    outcome: 'refused', code: 'APPLY_FAILED', message: '', dryRun, attemptId: input.attemptId, orderId: null, sessionId: null, provider: null, checks: null, actions: [],
    before: null, after: null, discovery: null, endedAs: null,
  }
  let operator: { id: string } | null = null
  const finish = (partial: Partial<Reconciliation> & Pick<Reconciliation, 'outcome' | 'code' | 'message'>): Reconciliation => {
    const result = { ...base, ...partial }
    incrementMetric('checkout_reconcile_total', 1, { outcome: result.outcome, code: result.code, mode: dryRun ? 'dry_run' : 'apply' })
    logEvent({ event: 'checkout.reconcile', level: result.outcome === 'refused' || result.outcome === 'partial' ? 'warn' : 'info', outcome: result.outcome, code: result.code, dryRun, attemptId: result.attemptId, orderId: result.orderId, sessionId: result.sessionId, operatorId: operator?.id ?? null, message: result.message })
    return result
  }
  const refuse = (code: ReconcileCode, message: string, extra: Partial<Reconciliation> = {}) => finish({ outcome: 'refused', code, message, ...extra })

  // 1. who
  operator = await authorizeOperator(input.operatorId)
  if (!operator) return refuse('OPERATOR_NOT_AUTHORIZED', 'The operator is not an administrator of this shop (or is suspended). Nothing was read or changed.')

  // 2. the attempt
  const found = await snapshot(input.attemptId)
  if (!found) return refuse('ATTEMPT_NOT_FOUND', 'No such payment attempt.')
  const orderId = found.orderId
  base.orderId = orderId
  base.before = { attempt: viewOf(found), order: orderViewOf(found.order) }
  if (FINAL_STATES.includes(found.status)) {
    return refuse('NOT_RECONCILABLE', `The attempt is "${found.status}": a payment is dealt with by the verified payment handling and by the administrator's decision about it, not here.`)
  }

  // 3. which session: the one given, the one the attempt already holds, or one found by looking - and a session that another attempt holds is never taken
  let sessionId: string | null = null
  if (input.sessionId) {
    if (!isSessionId(input.sessionId)) return refuse('SESSION_ID_INVALID', 'That is not the identifier of a Checkout session (cs_...).')
    if (found.stripeSessionId && found.stripeSessionId !== input.sessionId) return refuse('SESSION_CONFLICT', 'The attempt already holds a different session; it is never overwritten.')
    sessionId = input.sessionId
  } else if (found.stripeSessionId) {
    sessionId = found.stripeSessionId
  } else if (input.discover) {
    let discovery: Discovery
    try { discovery = await discoverSessions(found) } catch { return refuse('PROVIDER_UNAVAILABLE', 'The provider could not be asked to list the sessions. Nothing was changed.') }
    base.discovery = discovery
    if (discovery.matches.length === 0) {
      return finish({
        outcome: 'no_evidence', code: 'NO_EVIDENCE', discovery,
        message: `No session of the window names this attempt (${discovery.examined} examined in ${discovery.pages} page(s), listing ${discovery.complete ? 'complete' : 'NOT complete'}). That proves NOTHING - a listing can lag or be incomplete - so nothing was changed and the attempt stays blocked. Give the session explicitly when it is known.`,
      })
    }
    if (discovery.matches.length > 1) return refuse('AMBIGUOUS_EVIDENCE', `${discovery.matches.length} sessions name this attempt (${discovery.matches.join(', ')}): which one is the page is for a person to say. Nothing was changed.`, { discovery })
    sessionId = discovery.matches[0]
  } else {
    return refuse('NO_SESSION_GIVEN', 'Give the session (--session cs_...) or ask to look for it (--discover).')
  }
  base.sessionId = sessionId
  const holder = await prisma.paymentAttempt.findFirst({ where: { stripeSessionId: sessionId, NOT: { id: found.id } }, select: { id: true } })
  if (holder) return refuse('SESSION_CONFLICT', `The session is already held by another attempt (${holder.id}); it is never shared.`)

  // 4. read it NOW and identify it
  let session: Stripe.Checkout.Session
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId, undefined, { timeout: STRIPE_READ_TIMEOUT_MS })
  } catch {
    return refuse('PROVIDER_UNAVAILABLE', 'The session could not be read from the provider. Nothing was changed.')
  }
  const identification = identifySession({ attemptId: found.id, orderId, sessionId, session })
  base.checks = identification.checks
  base.provider = { status: session.status ?? null, paymentStatus: session.payment_status ?? null }
  if (!identification.ok) {
    const failed = Object.entries(identification.checks).filter(([, ok]) => !ok).map(([name]) => name)
    return refuse('SESSION_NOT_IDENTIFIED', `The session is not provably the one of this attempt and order (failed: ${failed.join(', ')}). Nothing was changed.`)
  }
  const state = classifySessionStatus(session.status)
  if (state === 'unknown') return refuse('UNKNOWN_PROVIDER_STATE', `The provider shows the session as "${String(session.status)}", a state this tool does not act on. Nothing was changed.`)
  const actions = plannedActions(found, sessionId, state)
  base.actions = actions

  // 5. dry-run: what would be done, written nowhere
  if (dryRun) return finish({ outcome: 'planned', code: 'dry_run', message: 'Dry run: the session is the one of this attempt. Nothing was written. Run again with --apply to do what the actions say.', actions })

  // 6. apply: the request is recorded BEFORE anything is done - if it can not be, nothing is
  const auditBase = {
    adminId: operator.id, targetType: 'PaymentAttempt', targetId: found.id, requestMethod: channel.requestMethod, requestPath: channel.requestPath,
  }
  const metadataOf = (extra: Record<string, unknown>): Prisma.InputJsonValue => JSON.parse(JSON.stringify({ orderId, attemptId: found.id, sessionId, checks: identification.checks, provider: base.provider, actions, discovery: base.discovery, ...extra }))
  // (in a transaction of its own: the audit log is a hash chain and the helper takes its chain lock inside a transaction - so that two runs at once chain one after the other)
  const record = (action: string, metadata: Prisma.InputJsonValue) =>
    prisma.$transaction((tx) => recordAdminAuditEvent({ ...auditBase, action, metadata }, tx), { maxWait: 10_000, timeout: 15_000 })
  try {
    await record(RECONCILE_AUDIT_REQUESTED, metadataOf({ before: base.before }))
  } catch {
    return refuse('AUDIT_UNAVAILABLE', 'The request could not be recorded in the audit log, so nothing was done.')
  }

  let ended: { ended: string; why: string | null } | null = null
  let failure: string | null = null
  try {
    ended = await applyKnownSession({ orderId }, found.id, session)
    await pageJobsSettled()
  } catch (error: any) {
    failure = typeof error?.code === 'string' ? error.code : 'error'
    await pageJobsSettled().catch(() => undefined)
  }
  const afterRow = await snapshot(found.id)
  const after = afterRow ? { attempt: viewOf(afterRow), order: orderViewOf(afterRow.order) } : null
  base.after = after
  base.endedAs = failure ? `failed:${failure}` : ended ? `${ended.ended}${ended.why ? `:${ended.why}` : ''}` : null

  const unchanged = !!(after && base.before && sameView(after, base.before))
  // A page that stays live on an order that can not be paid is not "done", whatever the steps said: the closing at the provider could not be proved, and the row is where it is found (report Q6).
  let pageLeft = false
  if (afterRow) {
    const attemptsNow = await prisma.paymentAttempt.findMany({ where: { orderId }, select: { id: true, status: true, stripeSessionId: true, failureReason: true, createdAt: true, expiresAt: true, amountReceivedCents: true } })
    pageLeft = hasLivePageOfUnpayableOrder(afterRow.order, attemptsNow)
  }
  const result: Reconciliation = failure
    ? unchanged
      ? { ...base, outcome: 'refused', code: 'APPLY_FAILED', message: `The settlement did not complete (${failure}) and nothing was changed. Nothing was released.`, actions, after }
      : { ...base, outcome: 'partial', code: 'APPLY_FAILED', message: `The settlement did not complete (${failure}). What was committed is committed - every step is conditional - and the rows are as "after" shows; run it again to continue. Nothing was released.`, actions, after }
    : pageLeft
      ? { ...base, outcome: 'partial', code: 'PAGE_NOT_CLOSED', message: 'The session is recorded on the attempt, but its page could not be PROVED closed at the provider and it is still live on an order that cannot be paid. It stays listed by the report (Q6); run this again when the provider answers.', actions, after }
      : unchanged
        ? { ...base, outcome: 'already_done', code: 'unchanged', message: 'Nothing to change: the attempt and the order already agree with what the provider shows.', actions, after }
        : { ...base, outcome: 'applied', code: 'ok', message: ended?.ended === 'settled' ? 'Done: the session is recorded and settled.' : `Done as far as this tool goes (${base.endedAs}): the rest is for the customer's own request.`, actions, after }
  try {
    await record(RECONCILE_AUDIT_FINISHED, metadataOf({ outcome: result.outcome, code: result.code, endedAs: base.endedAs, before: base.before, after }))
  } catch {
    logEvent({ event: 'checkout.reconcile', level: 'error', outcome: 'audit_finish_not_recorded', attemptId: found.id, orderId, sessionId })
    incrementMetric('checkout_reconcile_audit_finish_failed_total')
  }
  return finish({ ...result })
}
