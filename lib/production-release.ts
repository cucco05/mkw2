// Applying the release decision where an effect HAPPENS (step 4.6, S4).
//
// `releaseDecision` (lib/order-payment-policy.ts) is a pure rule. A rule that is read, then acted on a moment later, can be overtaken: the payment sync may put the
// order on hold, a dispute may land, a second administrator may click, between the check and the write. So every operation that changes what happens to an order
// in production does this, and nothing else:
//
//     withReleaseLock(orderId, 'assign-printer', async ({ tx, order, decision }) => { ...write with tx...; await recordAdminAuditEvent(..., tx) })
//
//   1. one transaction, 2. the order row is locked (`SELECT ... FOR UPDATE` - the SAME lock lib/payment-sync.ts and lib/payment-hold.ts take, so the payment
//   being settled and the operation are decided one after the other), 3. the order and its payment attempts are read AGAIN, under the lock, 4. the decision
//   is taken on those fresh facts, 5. the callback writes in the same transaction, the audit event last (lock order: order row, then the audit chain).
// Nothing that waits for the network runs inside the transaction. The outside services are handled by the journal of lib/external-effects.ts.
//
// `require: 'released'` (default): an order that is not released is refused with a 409 and NOTHING is written.
// `require: 'none'`: for the technical signals that must always be recorded (a PrintLab callback, a link): the callback decides what to do with `decision`.
import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'
import { RELEASE_FACTS_SELECT, refundOperationBlocksWhere, releaseDecision, type ReleaseDecision, type ReleaseState } from '@/lib/order-payment-policy'
import { classifyExternalFailure, readJournal, recordEffectOutcome, renewIntents, type EffectOutcome } from '@/lib/external-effects'
import { withFinancialRevision } from '@/lib/financial-revision'

export const RELEASE_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const

export class ProductionReleaseError extends Error {
  readonly status: number
  readonly code: string
  readonly releaseState: ReleaseState | null
  readonly decision: ReleaseDecision | null
  constructor(status: number, code: string, message: string, extra: { releaseState?: ReleaseState | null; decision?: ReleaseDecision | null } = {}) {
    super(message)
    this.name = 'ProductionReleaseError'
    this.status = status
    this.code = code
    this.releaseState = extra.releaseState ?? null
    this.decision = extra.decision ?? null
  }
}

// The body of a refusal, the same for every route: { error, code, releaseState }.
export function releaseRefusalBody(err: ProductionReleaseError) {
  return { error: err.message, code: err.code, ...(err.releaseState ? { releaseState: err.releaseState } : {}) }
}
// For route handlers: turns a refusal into its response, or returns null for any other error (the caller deals with it).
export function releaseErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof ProductionReleaseError)) return null
  return NextResponse.json(releaseRefusalBody(err), { status: err.status })
}

// Test seams, null in production (the same idea as `effectHooks` / `viewerGuards`): they let a test hold an operation at an exact point - under the lock, or
// around a call to an outside service - while something else tries to happen, and prove what the code does then.
export const releaseHooks: {
  afterLock?: (ctx: { orderId: string; action: string }) => Promise<void> | void
  beforeExternalCall?: (ctx: { orderId: string; action: string; effectKey: string }) => Promise<void> | void
  afterExternalCall?: (ctx: { orderId: string; action: string; effectKey: string }) => Promise<void> | void
} = {}

// (the refund operations loaded under the lock are only those that BLOCK production - lib/order-payment-policy.ts `refundOperationBlocks`)
export type LockedOrder = Prisma.PrintOrderGetPayload<{ include: { paymentAttempts: true; refundOperations: true } }>
export type ReleaseContext = { tx: Prisma.TransactionClient; order: LockedOrder; decision: ReleaseDecision }

export function noteRefusal(action: string, orderId: string, decision: ReleaseDecision | null, code: string) {
  incrementMetric('production_release_blocked_total', 1, { action, state: decision?.state ?? code })
  logEvent({ event: 'production.release', level: 'warn', outcome: 'refused', action, orderId, state: decision?.state ?? null, code, reviewReason: decision?.reviewReason ?? null })
}

// A technical signal (PrintLab callback / link) arrived for an order that is not released: it is recorded, it moves nothing, and a person can see it happened.
export function noteUnreleasedSignal(action: string, orderId: string, decision: ReleaseDecision, extra: Record<string, unknown> = {}) {
  incrementMetric('production_release_signal_unreleased_total', 1, { action, state: decision.state })
  logEvent({ event: 'production.release', level: 'warn', outcome: 'signal_recorded_only', action, orderId, state: decision.state, reviewReason: decision.reviewReason, ...extra })
}

export async function lockOrderRow(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${orderId} FOR UPDATE`
}

// The facts the decision needs, read without a lock (a pre-check, a view, or the re-check an outside call makes between two rows). Never the basis of a write.
export async function readReleaseFacts(client: Prisma.TransactionClient | typeof prisma, orderId: string) {
  return client.printOrder.findUnique({ where: { id: orderId }, select: { id: true, status: true, ...RELEASE_FACTS_SELECT } })
}

export async function withReleaseLock<T>(
  orderId: string,
  action: string,
  fn: (ctx: ReleaseContext) => Promise<T>,
  opts: { require?: 'released' | 'none'; allowStatuses?: readonly string[]; now?: Date } = {},
): Promise<T> {
  const seen: { refusal: { decision: ReleaseDecision | null; code: string } | null } = { refusal: null }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockOrderRow(tx, orderId)
      const order = await tx.printOrder.findUnique({ where: { id: orderId }, include: { paymentAttempts: true, refundOperations: { where: refundOperationBlocksWhere } } })
      if (!order) {
        seen.refusal = { decision: null, code: 'NOT_FOUND' }
        throw new ProductionReleaseError(404, 'NOT_FOUND', 'Order not found.')
      }
      const decision = releaseDecision(order, { now: opts.now })
      if (releaseHooks.afterLock) await releaseHooks.afterLock({ orderId, action })
      if ((opts.require ?? 'released') === 'released' && !decision.released) {
        seen.refusal = { decision, code: decision.code ?? 'NOT_RELEASED' }
        throw new ProductionReleaseError(409, decision.code ?? 'NOT_RELEASED', decision.message, { releaseState: decision.state, decision })
      }
      if (opts.allowStatuses && !opts.allowStatuses.includes(order.status)) {
        seen.refusal = { decision, code: 'ORDER_STATUS_NOT_ALLOWED' }
        throw new ProductionReleaseError(409, 'ORDER_STATUS_NOT_ALLOWED', `This operation is not possible while the order is "${order.status}" (allowed: ${opts.allowStatuses.join(', ')}).`, { releaseState: decision.state, decision })
      }
      return fn({ tx, order, decision })
    }, RELEASE_TX_OPTIONS)
  } catch (err) {
    // a refusal made by the gate itself, or one the operation made on the facts it read under the lock (e.g. the transition rule): both are counted and logged
    if (err instanceof ProductionReleaseError && err.code !== 'NOT_FOUND') noteRefusal(action, orderId, seen.refusal?.decision ?? err.decision, seen.refusal?.code ?? err.code)
    throw err
  }
}

// ---- one call to an outside service, guarded ----------------------------------------------------------------------------------------------------
// The network is never called inside a transaction, so between "the order was released" and "the service heard the request" there is a gap no lock can close.
// What is done about it: the check is made as late as possible (under the lock, right before the call, together with renewing the claim), the intent is already
// in the journal, and whatever happens after the call - the order put on hold, the process dying, the answer lost - is recorded for what it is. A block that
// arrives during the call is NOT undone (nothing is cancelled automatically, nothing is sent to a printer): the effect is marked `blockedAfterSend`.
export type EffectRunResult<T> =
  | { ran: false; reason: 'not_released' | 'status_not_allowed' | 'claim_lost'; decision: ReleaseDecision | null }
  | { ran: true; outcome: EffectOutcome; result: T | null; blockedAfterSend: boolean }

export type GuardedEffectArgs<T> = {
  orderId: string
  action: string
  key: string
  intentId: string
  // every intent of this operation that has not been sent yet (including this one): kept alive together, and closed as "not sent" if the operation stops
  owned: ReadonlyArray<{ key: string; intentId: string }>
  statusOk: (status: string) => boolean
  call: () => Promise<T>
  // what a call that returned means (a readable record -> confirmed; anything else -> uncertain)
  interpret: (result: T) => EffectOutcome
  // lets the caller keep its own records (e.g. the list of submissions shown on the order) in the SAME write as the outcome
  afterRecord?: (metadata: Record<string, unknown>, outcome: EffectOutcome, result: T | null) => Record<string, unknown>
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

export async function runGuardedEffect<T>(args: GuardedEffectArgs<T>): Promise<EffectRunResult<T>> {
  const { orderId, action, key, intentId } = args
  // 1. under the lock: still released, still in a status that allows this, our intent still ours - then the claim is renewed, or the operation stops
  const guard = await withReleaseLock(orderId, action, async ({ tx, order, decision }) => {
    const metadata = asRecord(order.metadata)
    const mine = readJournal(metadata)[key]
    const why: 'not_released' | 'status_not_allowed' | 'claim_lost' | null = !decision.released
      ? 'not_released'
      : !args.statusOk(order.status)
        ? 'status_not_allowed'
        : !mine || mine.state !== 'intent' || mine.intentId !== intentId
          ? 'claim_lost'
          : null
    if (why) {
      // Nothing was sent for the intents we still hold: they are closed as "not sent". An intent that is no longer ours is not touched.
      let next: Record<string, unknown> = metadata
      for (const owned of args.owned) {
        const record = readJournal(next)[owned.key]
        if (record && record.state === 'intent' && record.intentId === owned.intentId) {
          next = recordEffectOutcome(next, owned.key, owned.intentId, { state: 'not_sent', cause: 'aborted_before_send', message: `The operation stopped before this call (${why}).` }).metadata
        }
      }
      await tx.printOrder.update({ where: { id: orderId }, data: withFinancialRevision(order, { metadata: next as Prisma.InputJsonValue }) })
      return { go: false as const, why, decision }
    }
    const renewed = renewIntents(metadata, args.owned)
    await tx.printOrder.update({ where: { id: orderId }, data: withFinancialRevision(order, { metadata: renewed.metadata as Prisma.InputJsonValue }) })
    return { go: true as const }
  }, { require: 'none' })
  if (!guard.go) return { ran: false, reason: guard.why, decision: guard.decision }

  // 2. the call, outside any transaction
  if (releaseHooks.beforeExternalCall) await releaseHooks.beforeExternalCall({ orderId, action, effectKey: key })
  let outcome: EffectOutcome
  let result: T | null = null
  try {
    result = await args.call()
    outcome = args.interpret(result)
  } catch (err) {
    const failure = classifyExternalFailure(err)
    outcome = { state: failure.state, cause: failure.cause, message: failure.message, httpStatus: failure.httpStatus }
  }
  if (releaseHooks.afterExternalCall) await releaseHooks.afterExternalCall({ orderId, action, effectKey: key })

  // 3. the end of the attempt is recorded whatever the order has become meanwhile
  let blockedAfterSend = false
  try {
    await withReleaseLock(orderId, action, async ({ tx, order, decision }) => {
      blockedAfterSend = !decision.released
      let metadata = recordEffectOutcome(asRecord(order.metadata), key, intentId, outcome, { blockedAfterSend }).metadata
      if (args.afterRecord) metadata = args.afterRecord(metadata, outcome, result)
      await tx.printOrder.update({ where: { id: orderId }, data: withFinancialRevision(order, { metadata: metadata as Prisma.InputJsonValue }) })
      if (blockedAfterSend && outcome.state !== 'not_sent' && outcome.state !== 'rejected') {
        incrementMetric('production_release_blocked_after_send_total', 1, { action, state: decision.state })
        logEvent({ event: 'production.release', level: 'warn', outcome: 'blocked_after_send', action, orderId, effectKey: key, state: decision.state, reviewReason: decision.reviewReason })
      }
    }, { require: 'none' })
  } catch (err) {
    // The order is gone, or the database failed: the outcome could not be written. Say so loudly - the intent stays in the journal and will read as uncertain.
    logEvent({ event: 'production.release', level: 'error', outcome: 'outcome_not_recorded', action, orderId, effectKey: key, message: err instanceof Error ? err.message : String(err) })
    throw err
  }
  return { ran: true, outcome, result, blockedAfterSend }
}
