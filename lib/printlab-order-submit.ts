// Sending an order's items to PrintLab as jobs (step 4.6, S4). One POST per item, each with its own idempotency key.
//
// What protects the production line, in order:
//   1. the order must be RELEASED (lib/order-payment-policy.ts, releaseDecision) and `queued`, decided under the lock on the order;
//   2. for each item an INTENT is written to the order's journal BEFORE PrintLab is called (lib/external-effects.ts). A second request while the first is still
//      working is refused (409 SUBMIT_IN_PROGRESS): it can not send the same items again;
//   3. right before each call the order is checked again under the lock (still released, still queued, the intent still ours) and the claim is renewed;
//   4. the call has a timeout. How it ends is CLASSIFIED: never left / refused by PrintLab / done / unknown. An unknown end (timeout, dropped connection, 5xx, an
//      answer that is not a record) is never repeated: the item stays UNCERTAIN, also after the claim expires and after a restart of this process;
//   5. an uncertain item is looked for on PrintLab (reconciliation by PRESENCE: a job with this item's idempotency key, or this order and item). If it is there it
//      is confirmed; if it is not found it STAYS uncertain - not finding it proves nothing - and the administrator is told. The only other way out is an
//      administrator naming the PrintLab job, which the SERVER verifies on PrintLab (app/api/admin/orders/[orderId]/external-effects).
// We do not claim "exactly once": PrintLab may or may not honor the idempotency keys and that can not be verified from here. The guarantee is "at most one attempt per
// intent, never repeated while the outcome is unknown".
import { prisma } from '@/lib/db'
import { findLinkedJobForOrder } from '@/lib/orderworks-link'
import { fetchPrintLabJob, fetchPrintLabJobs, submitPrintLabMakerWorksJob, type PrintLabMakerWorksSubmitPayload } from '@/lib/printlab'
import { buildPrintLabSubmitPayloads } from '@/lib/printlab-submit'
import { PRINTLAB_SUBMIT_STATUSES, releaseDecision, RELEASE_FACTS_SELECT } from '@/lib/order-payment-policy'
import { withFinancialRevision } from '@/lib/financial-revision'
import {
  BAD_RESPONSE, beginEffects, confirmEffectByProof, readJournal, type EffectOutcome, type ExternalEffectRecord,
} from '@/lib/external-effects'
import { ProductionReleaseError, runGuardedEffect, withReleaseLock } from '@/lib/production-release'

type SubmitOptions = {
  actor: string
  adminId?: string | null
  throwOnFailure?: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err || 'PrintLab submission failed')
}

function jsonString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export const printLabEffectKey = (itemId: string) => `printlab:item:${itemId}`

// ---- looking for a job on PrintLab ---------------------------------------------------------------------------------------------------------
const RECONCILE_TIMEOUT_MS = 10_000

// Does this PrintLab job belong to this item of this order? By the idempotency key we sent, or - if PrintLab shows the order and the item it was made for.
export function printLabJobMatches(job: unknown, want: { orderId: string; itemId: string | null; idempotencyKey: string | null }): boolean {
  const row = asRecord(job)
  const key = jsonString(row.idempotency_key) ?? jsonString(row.idempotencyKey)
  if (want.idempotencyKey && key === want.idempotencyKey) return true
  const sourceOrder = jsonString(row.source_order_id) ?? jsonString(row.sourceOrderId)
  const metadata = asRecord(row.metadata)
  const item = jsonString(metadata.item_id) ?? jsonString(metadata.itemId)
  return Boolean(want.itemId) && sourceOrder === want.orderId && item === want.itemId
}

export type PresenceCheck = { checked: boolean; found: { id: string; status: string | null } | null; problem: string | null }

// Reconciliation BY PRESENCE: a record that is found is proof. A record that is not found proves nothing (PrintLab may lag, may not list it, may be unreachable).
export async function findPrintLabJobForEffect(orderId: string, record: Pick<ExternalEffectRecord, 'detail'>): Promise<PresenceCheck> {
  const want = {
    orderId,
    itemId: jsonString(record.detail.itemId),
    idempotencyKey: jsonString(record.detail.idempotencyKey),
  }
  try {
    const jobs = await fetchPrintLabJobs({ timeoutMs: RECONCILE_TIMEOUT_MS })
    const match = jobs.find((job: unknown) => printLabJobMatches(job, want))
    return { checked: true, found: match ? { id: String(asRecord(match).id ?? ''), status: jsonString(asRecord(match).status) } : null, problem: null }
  } catch (err) {
    return { checked: false, found: null, problem: errorMessage(err) }
  }
}

// An administrator names a PrintLab job as the proof: the SERVER fetches it from PrintLab and checks it belongs to this item of this order.
export async function verifyPrintLabJobForEffect(orderId: string, record: Pick<ExternalEffectRecord, 'detail'>, jobId: string): Promise<{ verified: boolean; status: string | null; reason: string | null }> {
  const want = { orderId, itemId: jsonString(record.detail.itemId), idempotencyKey: jsonString(record.detail.idempotencyKey) }
  try {
    const job = await fetchPrintLabJob(jobId, { timeoutMs: RECONCILE_TIMEOUT_MS })
    if (!job || typeof job !== 'object') return { verified: false, status: null, reason: 'PrintLab did not return that job.' }
    if (jsonString(asRecord(job).id) !== jobId.trim()) return { verified: false, status: null, reason: 'PrintLab returned a different job than the one named.' }
    return printLabJobMatches(job, want)
      ? { verified: true, status: jsonString(asRecord(job).status), reason: null }
      : { verified: false, status: null, reason: 'That PrintLab job is not tied to this order and item (its idempotency key and its order/item do not match).' }
  } catch (err) {
    return { verified: false, status: null, reason: `PrintLab could not be asked: ${errorMessage(err)}` }
  }
}

// ---- the records shown on the order (kept as before) ---------------------------------------------------------------------------------------------------
function appendSubmission(metadata: Record<string, unknown>, entry: Record<string, unknown>): Record<string, unknown> {
  const prior = Array.isArray(metadata.printLabSubmissions) ? metadata.printLabSubmissions : []
  return { ...metadata, printLabSubmissions: [...prior, entry], lastPrintLabSubmission: entry }
}

export type SubmitResult = {
  ok: boolean
  submitted: any[]
  errors: Array<{ itemId: string | null; message: string; outcome?: string }>
  // confirmed earlier, or found on PrintLab now: not sent again
  alreadyDone: string[]
  reconciled: string[]
  // items whose earlier attempt has an outcome nobody knows: nothing was sent for them
  unknownOutcome: string[]
  stoppedEarly: boolean
}

export async function submitOrderToPrintLab(orderId: string, options: SubmitOptions): Promise<SubmitResult> {
  const order = await prisma.printOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  })
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 })

  const linkedJob = await findLinkedJobForOrder(order.id, order.metadata)
  const payloads = buildPrintLabSubmitPayloads(order, linkedJob)
  if (payloads.length === 0) {
    // Not released is the more important answer; "nothing to send" only for an order that could be sent.
    const facts = await prisma.printOrder.findUnique({ where: { id: orderId }, select: RELEASE_FACTS_SELECT })
    const decision = facts ? releaseDecision(facts) : null
    if (decision && !decision.released) throw new ProductionReleaseError(409, decision.code ?? 'NOT_RELEASED', decision.message, { releaseState: decision.state, decision })
    throw Object.assign(new Error('Order is not ready for PrintLab submission.'), { status: 400 })
  }
  const keyOf = (payload: PrintLabMakerWorksSubmitPayload) => printLabEffectKey(String(payload.metadata?.item_id))
  const itemIdOf = (payload: PrintLabMakerWorksSubmitPayload) => jsonString(payload.metadata?.item_id)

  // ---- A. under the lock: released and queued? then an intent for every item that has to be sent (and nothing is sent twice) ----
  const begun = await withReleaseLock(orderId, 'printlab-submit', async ({ tx, order: fresh }) => {
    const result = beginEffects(fresh.metadata, payloads.map((payload) => ({
      key: keyOf(payload),
      kind: 'printlab_submit' as const,
      by: options.actor,
      adminId: options.adminId ?? null,
      detail: { idempotencyKey: payload.idempotency_key, itemId: itemIdOf(payload), sourceOrderId: payload.source_order_id },
    })), { metadataLost: fresh.metadata === null })
    if (Object.values(result.verdicts).some((entry) => entry.verdict === 'in_progress')) {
      throw new ProductionReleaseError(409, 'SUBMIT_IN_PROGRESS', 'This order is already being sent to PrintLab by another request. Nothing was sent again.')
    }
    if (Object.values(result.verdicts).some((entry) => entry.verdict !== 'already_done')) {
      await tx.printOrder.update({ where: { id: orderId }, data: withFinancialRevision(fresh, { metadata: result.metadata as any }) })
    }
    return result.verdicts
  }, { require: 'released', allowStatuses: PRINTLAB_SUBMIT_STATUSES })

  const outcome: SubmitResult = { ok: true, submitted: [], errors: [], alreadyDone: [], reconciled: [], unknownOutcome: [], stoppedEarly: false }

  // ---- B. items whose earlier attempt is unknown: look for them on PrintLab (presence only) ----
  for (const payload of payloads) {
    const key = keyOf(payload)
    const verdict = begun[key]
    if (verdict.verdict === 'already_done') { outcome.alreadyDone.push(String(itemIdOf(payload))); continue }
    if (verdict.verdict !== 'unknown_outcome') continue
    const presence = await findPrintLabJobForEffect(orderId, verdict.record)
    if (presence.found) {
      await withReleaseLock(orderId, 'printlab-submit', async ({ tx, order: fresh }) => {
        const proven = confirmEffectByProof(fresh.metadata, key, { externalId: presence.found!.id, confirmedBy: 'reconciliation', note: 'Found on PrintLab by its idempotency key / order and item.' })
        if (!proven.applied) return
        const metadata = appendSubmission(proven.metadata, {
          at: new Date().toISOString(), actor: options.actor, adminId: options.adminId ?? null, itemId: itemIdOf(payload), idempotencyKey: payload.idempotency_key,
          printLabJobId: presence.found!.id, status: presence.found!.status, reconciled: true,
        })
        await tx.printOrder.update({ where: { id: orderId }, data: withFinancialRevision(fresh, { metadata: metadata as any }) })
      }, { require: 'none' })
      outcome.reconciled.push(String(itemIdOf(payload)))
      continue
    }
    outcome.unknownOutcome.push(String(itemIdOf(payload)))
    outcome.errors.push({
      itemId: itemIdOf(payload),
      outcome: 'unknown',
      message: `The outcome of an earlier attempt to send this item is not known (${verdict.record.cause ?? 'unknown'})${presence.checked ? ' and PrintLab does not list a job for it' : `; PrintLab could not be asked (${presence.problem})`}. It was NOT sent again: check PrintLab, then confirm the job from the order page.`,
    })
  }

  // ---- C. items with a fresh intent: check again right before each call, call, record how it ended ----
  const toSend = payloads.filter((payload) => begun[keyOf(payload)].verdict === 'proceed')
  const owned = toSend.map((payload) => ({ key: keyOf(payload), intentId: begun[keyOf(payload)].record.intentId }))
  for (let index = 0; index < toSend.length; index++) {
    const payload = toSend[index]
    const key = keyOf(payload)
    const intentId = begun[key].record.intentId
    const run = await runGuardedEffect<any>({
      orderId,
      action: 'printlab-submit',
      key,
      intentId,
      owned: owned.slice(index),
      statusOk: (status) => PRINTLAB_SUBMIT_STATUSES.includes(status),
      call: () => submitPrintLabMakerWorksJob(payload),
      interpret: (job): EffectOutcome => (job && typeof job === 'object' && !Array.isArray(job)
        ? { state: 'confirmed', externalId: jsonString((job as any).id), httpStatus: 200 }
        : { state: 'uncertain', cause: BAD_RESPONSE.cause, message: BAD_RESPONSE.message, httpStatus: null }),
      afterRecord: (metadata, end, job) => {
        const base = { at: new Date().toISOString(), actor: options.actor, adminId: options.adminId ?? null, itemId: itemIdOf(payload) }
        if (end.state === 'confirmed') {
          return appendSubmission(metadata, {
            ...base, idempotencyKey: payload.idempotency_key, printLabJobId: job?.id ?? null, status: job?.status ?? null,
            printerId: job?.printer_id ?? null, printerName: job?.printer_name ?? null, queueItemId: job?.queue_item_id ?? null,
          })
        }
        return appendSubmission(metadata, { ...base, status: 'failed', outcome: end.state, error: end.message })
      },
    })
    if (!run.ran) {
      // the order is no longer released / queued (or the claim was lost): this item and the ones after it were NOT sent
      outcome.stoppedEarly = true
      outcome.errors.push({ itemId: itemIdOf(payload), outcome: 'not_sent', message: run.reason === 'not_released' ? 'The order is no longer released to production; this item and the following ones were not sent.' : run.reason === 'status_not_allowed' ? 'The order is no longer queued; this item and the following ones were not sent.' : 'Another request took over this order; this item was not sent.' })
      break
    }
    if (run.outcome.state === 'confirmed') outcome.submitted.push(run.result)
    else outcome.errors.push({ itemId: itemIdOf(payload), outcome: run.outcome.state, message: run.outcome.message })
  }

  outcome.ok = outcome.errors.length === 0
  if (!outcome.ok && options.throwOnFailure) {
    const message = outcome.errors.map((entry) => entry.message).join('; ')
    const unknown = outcome.unknownOutcome.length > 0 || outcome.errors.some((entry) => entry.outcome === 'uncertain')
    throw Object.assign(new Error(message), {
      status: unknown ? 409 : outcome.stoppedEarly ? 409 : 400,
      code: unknown ? 'SUBMIT_OUTCOME_UNKNOWN' : outcome.stoppedEarly ? 'RELEASE_CHANGED' : undefined,
      submitted: outcome.submitted,
      errors: outcome.errors,
    })
  }
  return outcome
}

export async function autoSubmitOrderToPrintLab(orderId: string, actor: string) {
  try {
    return await submitOrderToPrintLab(orderId, { actor, throwOnFailure: false })
  } catch (err) {
    console.error('PrintLab auto-submit failed:', err)
    return { ok: false, submitted: [], errors: [{ itemId: null, message: errorMessage(err) }], alreadyDone: [], reconciled: [], unknownOutcome: [], stoppedEarly: false } as SubmitResult
  }
}

// Which items of an order have a journal entry, for the screens.
export function printLabEffectsOf(metadata: unknown) {
  return Object.entries(readJournal(metadata)).filter(([, record]) => record.kind === 'printlab_submit').map(([key, record]) => ({ key, record }))
}
