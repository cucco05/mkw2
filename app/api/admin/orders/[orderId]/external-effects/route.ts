import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { rejectCrossOrigin, requireAdmin, requireRole } from '@/app/api/admin/_utils'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { ADMIN_ACTION_REASON_MAX_LENGTH, requireAdminReason } from '@/lib/order-payment-evidence'
import { confirmEffectByProof, describeEffect, readJournal } from '@/lib/external-effects'
import { verifyPrintLabJobForEffect } from '@/lib/printlab-order-submit'
import { maybeConsumeStockForOrder, verifyStockMovementForEffect } from '@/lib/stockworks-consumption'
import { releaseErrorResponse, withReleaseLock } from '@/lib/production-release'
import { withFinancialRevision } from '@/lib/financial-revision'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ orderId: string }> }

// What the order has told PrintLab and StockWorks, and how each call ended (lib/external-effects.ts). Read-only, no outside call.
export async function GET(_req: NextRequest, { params }: Context) {
  try { await requireAdmin() } catch (e: any) { return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 }) }
  const { orderId } = await params
  const order = await prisma.printOrder.findUnique({ where: { id: orderId }, select: { id: true, metadata: true } })
  if (!order) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  const effects = Object.entries(readJournal(order.metadata)).map(([key, record]) => ({ key, ...record, summary: describeEffect(key, record) }))
  return NextResponse.json({ orderId: order.id, effects, unresolved: effects.filter((entry) => entry.state === 'uncertain' || entry.state === 'intent').length })
}

const payloadSchema = z.object({
  effectKey: z.string().trim().min(1).max(300),
  // The identifier of the record on the OUTSIDE service (a PrintLab job id, a StockWorks movement id). The server looks it up there.
  externalId: z.string().trim().min(1).max(200),
  reason: z.string().max(ADMIN_ACTION_REASON_MAX_LENGTH).optional(),
}).strict() // no other field is understood: in particular there is no way to ask for "send it again" or to say "it did not happen"

// POST - confirm that an effect whose outcome was not known DID happen, by naming the record on the outside service. This is the only manual way out of "uncertain",
// and it is not a declaration: the server fetches the record from PrintLab / StockWorks and checks that it belongs to THIS order (idempotency key, or order + item;
// reference, inventory item and amount). If the record can not be verified the answer is 409 NO_RELIABLE_PROOF and nothing changes.
// There is NO action here (or anywhere) that says "it did not happen, send it again": not finding a record proves nothing, and an administrator's word is not proof.
export async function POST(req: NextRequest, { params }: Context) {
  let adminId = ''
  try { adminId = await requireRole(['admin']) } catch (e: any) {
    return NextResponse.json({ error: e.status === 403 ? 'Only administrators can confirm an outside effect.' : (e.message || 'Unauthorized'), code: e.status === 403 ? 'ADMIN_ONLY' : undefined }, { status: e.status || 401 })
  }
  const crossOrigin = rejectCrossOrigin(req)
  if (crossOrigin) return crossOrigin

  let payload: z.infer<typeof payloadSchema>
  let reason: string
  try {
    payload = payloadSchema.parse(await req.json())
    reason = requireAdminReason(payload.reason)
  } catch (e: any) {
    return NextResponse.json({ error: e?.issues?.[0]?.message || e?.message || 'Invalid request body.', code: e?.code }, { status: e?.status || 400 })
  }

  const { orderId } = await params
  const order = await prisma.printOrder.findUnique({ where: { id: orderId }, select: { id: true, metadata: true } })
  if (!order) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  const record = readJournal(order.metadata)[payload.effectKey]
  if (!record) return NextResponse.json({ error: 'The order has no such outside effect.', code: 'EFFECT_NOT_FOUND' }, { status: 404 })
  if (record.state === 'confirmed') return NextResponse.json({ error: 'That effect is already confirmed.', code: 'ALREADY_CONFIRMED' }, { status: 409 })
  if (record.state === 'intent' && Date.parse(record.claimUntil || '') > Date.now()) {
    return NextResponse.json({ error: 'That call is still being made by another request. Try again when it has finished.', code: 'IN_PROGRESS' }, { status: 409 })
  }

  // the proof is looked up on the outside service, outside any transaction
  const proof = record.kind === 'printlab_submit'
    ? await verifyPrintLabJobForEffect(orderId, record, payload.externalId)
    : await verifyStockMovementForEffect(record, payload.externalId)
  const requestMeta = getAdminAuditRequestMeta(req)
  if (!proof.verified) {
    // the attempt is itself worth keeping: someone tried to settle an uncertain outcome without proof
    try {
      await recordAdminAuditEvent({
        adminId, action: 'admin.order.external_effect.proof_refused', targetType: 'print_order', targetId: orderId, ...requestMeta,
        metadata: { effectKey: payload.effectKey, externalId: payload.externalId, state: record.state, reason, why: proof.reason },
      })
    } catch { /* the refusal below is what matters */ }
    return NextResponse.json({
      error: `The record could not be verified on the outside service, so the outcome stays unknown: ${proof.reason ?? 'no reason given'}`,
      code: 'NO_RELIABLE_PROOF',
    }, { status: 409 })
  }

  try {
    const effect = await withReleaseLock(orderId, 'external-effect-proof', async ({ tx, order: fresh }) => {
      const proven = confirmEffectByProof(fresh.metadata, payload.effectKey, { externalId: payload.externalId.trim(), confirmedBy: 'admin_proof', adminId, note: `Confirmed by an administrator against the outside record. ${reason}` })
      if (!proven.applied) return null
      await tx.printOrder.update({ where: { id: orderId }, data: withFinancialRevision(fresh, { metadata: proven.metadata as any }) })
      await recordAdminAuditEvent({
        adminId, action: 'admin.order.external_effect.confirm', targetType: 'print_order', targetId: orderId, ...requestMeta,
        metadata: { effectKey: payload.effectKey, externalId: payload.externalId, before: proven.before, reason },
      }, tx)
      return readJournal(proven.metadata)[payload.effectKey]
    }, { require: 'none' })
    if (!effect) return NextResponse.json({ error: 'That effect changed in the meantime; reload the order.', code: 'EFFECT_CHANGED' }, { status: 409 })

    // A StockWorks line confirmed: the order's consumption may now be complete (it writes nothing that is already done).
    let consumption: unknown = null
    if (record.kind === 'stockworks_movement') {
      try { consumption = await maybeConsumeStockForOrder(orderId, 'admin-external-effect-proof') } catch (e: any) { consumption = { ok: false, error: e?.message || 'unknown error' } }
    }
    return NextResponse.json({ ok: true, effect: { key: payload.effectKey, ...effect }, consumption })
  } catch (e: any) {
    const refusal = releaseErrorResponse(e)
    if (refusal) return refusal
    return NextResponse.json({ error: e?.message || 'Could not confirm the effect.' }, { status: 400 })
  }
}
