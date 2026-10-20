import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { rejectCrossOrigin, requireAdmin, requireRole } from '@/app/api/admin/_utils'
import { ORDER_STATUS_FLOW } from '@/lib/order-status'
import { maybeConsumeStockForOrder } from '@/lib/stockworks-consumption'
import { syncJobFulfillmentFromOrderStatus } from '@/lib/orderworks-sync'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { checkManualTransition } from '@/lib/order-payment-policy'
import { CANCELLATION_REASON_MIN_LENGTH, productionJobEvidence } from '@/lib/external-effects'
import { ProductionReleaseError, releaseErrorResponse, withReleaseLock } from '@/lib/production-release'
import { withFinancialRevision } from '@/lib/financial-revision'

const statusKeys = ORDER_STATUS_FLOW.map((entry) => entry.key) as [string, ...string[]]

const payloadSchema = z.object({
  status: z.enum(statusKeys),
  failureNote: z.string().max(400).optional(),
  // Explicit administrator decision to start production although payment is not verified (recorded on the order).
  authorizeUnpaid: z.boolean().optional(),
  authorizationReason: z.string().max(300).optional(),
  // (step 4.6, S6) 'exceptional' (default) or, for an invoice / purchase-order order produced before the money arrives, 'commercial_credit' with the reference of the invoice or order
  authorizationKind: z.enum(['exceptional', 'commercial_credit']).optional(),
  creditReference: z.string().max(200).optional(),
  creditDueAt: z.string().max(40).optional(),
  // Cancelling an order that was already sent to production needs a written reason (nothing is stopped at PrintLab or on a printer from here).
  cancellationReason: z.string().max(300).optional(),
})

type RouteParams = { params: Promise<{ orderId: string }> }

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  let adminId = ''
  try { adminId = await requireAdmin() } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 })
  }
  const crossOrigin = rejectCrossOrigin(req)
  if (crossOrigin) return crossOrigin

  try {
    const { orderId } = await params
    const payload = payloadSchema.parse(await req.json())
    const isFailed = payload.status === 'failed'
    // Starting production needs a verified payment or an explicit authorization by an administrator (not staff).
    if (payload.authorizeUnpaid) {
      try { await requireRole(['admin']) } catch (e: any) {
        return NextResponse.json({ error: 'Only administrators can authorize production without a verified payment.' }, { status: e.status || 403 })
      }
    }
    const requestMeta = getAdminAuditRequestMeta(req)

    // Everything is decided and written under the lock on the order, on the facts read AFTER the lock: the payment may have changed a moment ago.
    const done = await withReleaseLock(orderId, 'order-status', async ({ tx, order: current, decision }) => {
      const transition = checkManualTransition(current, payload.status, {
        authorizeUnpaid: payload.authorizeUnpaid,
        adminId,
        reason: payload.authorizationReason,
        kind: payload.authorizationKind,
        creditReference: payload.creditReference,
        creditDueAt: payload.creditDueAt,
      })
      if (!transition.allowed) {
        throw new ProductionReleaseError(transition.httpStatus ?? 409, transition.code ?? 'PAYMENT_NOT_VERIFIED', transition.error, { releaseState: transition.releaseState ?? decision.state, decision })
      }

      let metadata: Record<string, unknown> | null = transition.metadata ?? null
      const evidence = payload.status === 'cancelled' && current.status !== 'cancelled' ? productionJobEvidence(current) : []
      const cancellationReason = (payload.cancellationReason ?? '').trim()
      if (evidence.length > 0) {
        if (cancellationReason.length < CANCELLATION_REASON_MIN_LENGTH) {
          throw new ProductionReleaseError(
            409,
            'CANCELLATION_REASON_REQUIRED',
            `This order has already gone to production (${evidence.join(', ')}). Cancelling it here does not stop anything at PrintLab or on a printer: stop or cancel the job there first, then cancel the order with a written reason (at least ${CANCELLATION_REASON_MIN_LENGTH} characters).`,
            { releaseState: decision.state, decision },
          )
        }
        const base = metadata ?? (current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata) ? current.metadata as Record<string, unknown> : {})
        metadata = { ...base, cancellation: { reason: 'admin_cancelled_after_production', note: cancellationReason, at: new Date().toISOString(), by: adminId, evidence } }
      }

      // (step 4.6, S6, P2b) cancelling or re-opening an order is a change of its money situation: the financial revision goes up in this same UPDATE. Granting the
      // authorization itself does not change it (it records the revision the order has now).
      const order = await tx.printOrder.update({
        where: { id: current.id },
        data: withFinancialRevision(current, {
          status: payload.status,
          failedAt: isFailed ? new Date() : null,
          failureNote: isFailed ? (payload.failureNote?.trim() || null) : null,
          ...(payload.status === 'queued' ? { printerId: null, printerAssignedAt: null, printerAssignedBy: null } : {}),
          ...(metadata ? { metadata: metadata as any } : {}),
        }),
        select: { id: true, status: true },
      })
      const release = transition.release ?? decision
      const granted = (transition.metadata as Record<string, any> | undefined)?.productionAuthorization as Record<string, any> | undefined
      // the decision of a commercial credit has its own audit event (the amount still due is in it), in the same transaction as the decision
      if (granted?.kind === 'commercial_credit') {
        await recordAdminAuditEvent({
          adminId,
          action: 'admin.order.commercial_credit.authorize',
          targetType: 'print_order',
          targetId: order.id,
          requestMethod: requestMeta.requestMethod,
          requestPath: requestMeta.requestPath,
          requestIp: requestMeta.requestIp,
          userAgent: requestMeta.userAgent,
          metadata: { reason: payload.authorizationReason ?? null, credit: granted.credit, financialRevision: granted.financialRevision, previousStatus: current.status, status: payload.status } as any,
        }, tx)
      }
      await recordAdminAuditEvent({
        adminId,
        action: 'admin.order.status.update',
        targetType: 'print_order',
        targetId: order.id,
        requestMethod: requestMeta.requestMethod,
        requestPath: requestMeta.requestPath,
        requestIp: requestMeta.requestIp,
        userAgent: requestMeta.userAgent,
        metadata: {
          status: payload.status,
          previousStatus: current.status,
          failureNote: payload.failureNote || null,
          productionAuthorizedWithoutPayment: Boolean(transition.metadata),
          authorizationReason: payload.authorizationReason || null,
          cancellationReason: evidence.length > 0 ? cancellationReason : null,
          releaseState: release.state,
          releaseBasis: transition.metadata ? (granted?.kind === 'commercial_credit' ? 'commercial_credit' : 'admin_authorization') : release.basis,
        } as any,
      }, tx)
      return { order, release: { state: release.state, basis: transition.metadata ? (granted?.kind === 'commercial_credit' ? 'commercial_credit' : 'admin_authorization') : release.basis } }
    }, { require: 'none' })

    // After the commit: the follow-ups. The status is saved and audited; a follow-up that fails is reported, it does not undo or hide the change.
    const warnings: string[] = []
    try { await syncJobFulfillmentFromOrderStatus(done.order.id) } catch (e: any) { warnings.push(`OrderWorks job not updated: ${e?.message || 'unknown error'}`) }
    try {
      const stock = await maybeConsumeStockForOrder(done.order.id, 'admin-status-update')
      if (!stock.ok && (stock as any).reason === 'outcome_unknown') warnings.push('StockWorks: the outcome of an earlier stock movement is not known. Check StockWorks before anything is repeated (see the order\'s production panel).')
    } catch (e: any) { warnings.push(`StockWorks not updated: ${e?.message || 'unknown error'}`) }
    return NextResponse.json({ order: done.order, release: done.release, ...(warnings.length > 0 ? { warnings } : {}) })
  } catch (e: any) {
    const refusal = releaseErrorResponse(e)
    if (refusal) return refusal
    return NextResponse.json({ error: e.message || 'Invalid request.' }, { status: 400 })
  }
}
