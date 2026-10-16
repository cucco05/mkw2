import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireRole } from '../../../_utils'
import { isSameOriginRequest } from '@/lib/csrf'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { AdminActionError, assertNoStripeEvidence, loadStripeEvidence, requireAdminReason } from '@/lib/order-payment-evidence'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// DELETE /api/admin/orderworks/jobs/<id> - removes a job form AND the orders made from it (step 4.6, D8). Administrators only (not staff), same origin, a written
// reason (JSON body `{ "reason": "..." }`), an audit event written in the same transaction. If ANY of those orders carries proof of a Stripe payment (or one on
// hold) nothing is deleted: money that really moved is not erased from here.
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params
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
    const result = await prisma.$transaction(async (tx) => {
      const job = await tx.jobForm.findUnique({
        where: { id },
        select: { id: true, paymentIntentId: true, paymentMethod: true, paymentStatus: true, totalCents: true },
      })
      if (!job) {
        const err = new Error('Job not found') as Error & { code?: string }
        err.code = 'P2025'
        throw err
      }

      const linkedOrders = await tx.printOrder.findMany({
        where: {
          OR: [
            {
              metadata: {
                path: ['paymentIntentId'],
                equals: job.paymentIntentId,
              },
            },
            {
              metadata: {
                path: ['jobFormId'],
                equals: job.id,
              },
            },
          ],
        },
        select: { id: true, orderNumber: true },
      })

      const linkedOrderIds = linkedOrders.map((order) => order.id)
      for (const orderId of linkedOrderIds) {
        const evidence = await loadStripeEvidence(tx, orderId)
        if (evidence) assertNoStripeEvidence(evidence)
      }
      if (linkedOrderIds.length > 0) {
        // Prevent self-relation FK violations before removing source orders.
        await tx.printOrder.updateMany({
          where: { reprintOfId: { in: linkedOrderIds } },
          data: { reprintOfId: null },
        })
        await tx.printOrder.deleteMany({
          where: { id: { in: linkedOrderIds } },
        })
      }

      await tx.jobForm.delete({ where: { id: job.id } })
      await recordAdminAuditEvent({
        adminId,
        action: 'admin.orderworks_job.delete',
        targetType: 'job_form',
        targetId: job.id,
        ...getAdminAuditRequestMeta(req),
        metadata: {
          reason, paymentIntentId: job.paymentIntentId, paymentMethod: job.paymentMethod, paymentStatus: job.paymentStatus, totalCents: job.totalCents,
          deletedOrders: linkedOrders.map((order) => ({ id: order.id, orderNumber: order.orderNumber })),
        },
      }, tx)
      return { deletedOrderCount: linkedOrderIds.length }
    })

    return NextResponse.json({ ok: true, deletedOrderCount: result.deletedOrderCount })
  } catch (err: any) {
    if (err instanceof AdminActionError) return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: err.status })
    const message = err?.code === 'P2025' ? 'Job not found' : 'Failed to delete job'
    return NextResponse.json({ error: message }, { status: err?.code === 'P2025' ? 404 : 500 })
  }
}
