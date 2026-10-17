import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireRole } from '@/app/api/admin/_utils'
import { isSameOriginRequest } from '@/lib/csrf'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { AdminActionError, assertNoStripeEvidence, loadStripeEvidence, requireAdminReason } from '@/lib/order-payment-evidence'
import { extractJobFormId, extractPaymentIntentId } from '@/lib/orderworks-link'
import { productionJobEvidence } from '@/lib/external-effects'
import { lockOrderRow } from '@/lib/production-release'

type RouteParams = { params: Promise<{ orderId: string }> }

// DELETE /api/admin/orders/<id> (step 4.6, D5/D8). Administrators only (not staff), same origin, a written reason (JSON body `{ "reason": "..." }`), an audit event
// written in the same transaction. An order that carries proof of a Stripe payment (an attempt, a Stripe id, a payment date, a refund, Stripe data, a payment on
// hold) cannot be deleted from here: it is the record of money that moved (lib/order-payment-evidence.ts).
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  let adminId = ''
  try {
    adminId = await requireRole(['admin'])
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 })
  }
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid request origin.', code: 'INVALID_ORIGIN' }, { status: 403 })
  let reason = ''
  try {
    const body = await req.json().catch(() => null)
    reason = requireAdminReason(body && typeof body === 'object' ? (body as Record<string, unknown>).reason : undefined)
  } catch (err: any) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status || 400 })
  }

  try {
    const { orderId } = await params
    await prisma.$transaction(async (tx) => {
      // the row is locked first: a job being sent to PrintLab at this very moment either has written its intent (and is seen below) or finds the order gone
      await lockOrderRow(tx, orderId)
      const existing = await tx.printOrder.findUnique({
        where: { id: orderId },
        select: { id: true, orderNumber: true, metadata: true, status: true, paymentStatus: true, paymentMethod: true, totalCents: true },
      })
      if (!existing) {
        const err = new Error('Order not found') as Error & { code?: string }
        err.code = 'P2025'
        throw err
      }
      const evidence = await loadStripeEvidence(tx, orderId)
      if (evidence) assertNoStripeEvidence(evidence)
      // An order that already went to production is the only record of that job: deleting it would leave the job in PrintLab (or the material taken from stock)
      // without an order. It is kept; to end it, cancel it with a written reason (and stop the job in PrintLab first - nothing is sent to a printer from here).
      const production = productionJobEvidence(existing)
      if (production.length > 0) {
        throw new AdminActionError('ORDER_HAS_PRODUCTION_JOB', 'This order has already gone to production, so it can not be deleted: it would leave its job without an order. Cancel it instead, with a written reason.', 409, { evidence: production })
      }

      const paymentIntentId = extractPaymentIntentId(existing.metadata)
      const jobFormId = extractJobFormId(existing.metadata)
      const whereOr: any[] = [{ metadata: { path: ['orderId'], equals: orderId } }]
      if (paymentIntentId) whereOr.push({ paymentIntentId })
      if (jobFormId) whereOr.push({ id: jobFormId })
      await tx.jobForm.deleteMany({ where: { OR: whereOr } })

      // Avoid self-relation constraint issues before deleting the source order.
      await tx.printOrder.updateMany({
        where: { reprintOfId: orderId },
        data: { reprintOfId: null },
      })
      await tx.printOrder.delete({ where: { id: orderId } })
      await recordAdminAuditEvent({
        adminId,
        action: 'admin.order.delete',
        targetType: 'order',
        targetId: orderId,
        ...getAdminAuditRequestMeta(req),
        metadata: {
          reason, orderNumber: existing.orderNumber, status: existing.status, paymentStatus: existing.paymentStatus, paymentMethod: existing.paymentMethod, totalCents: existing.totalCents,
        },
      }, tx)
    })

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e instanceof AdminActionError) return NextResponse.json({ error: e.message, code: e.code, details: e.details }, { status: e.status })
    const status = e?.code === 'P2025' ? 404 : 500
    const error = e?.code === 'P2025' ? 'Order not found' : 'Failed to delete order'
    return NextResponse.json({ error }, { status })
  }
}
