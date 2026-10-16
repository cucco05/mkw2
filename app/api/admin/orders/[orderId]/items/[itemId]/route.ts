import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireRole } from '@/app/api/admin/_utils'
import { isSameOriginRequest } from '@/lib/csrf'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { AdminActionError, assertNoStripeEvidence, loadStripeEvidence, requireAdminReason } from '@/lib/order-payment-evidence'
import { syncLinkedJobsFromOrder } from '@/lib/orderworks-sync'

const payloadSchema = z.object({
  quantity: z.number().int().min(1).max(999),
  // step 4.6: the written reason every critical admin action needs
  reason: z.string().max(600).optional(),
})

type RouteParams = { params: Promise<{ orderId: string; itemId: string }> }

// PATCH /api/admin/orders/<id>/items/<id> - changes the quantity of a line and re-computes the order total (step 4.6, D5). Administrators only (not staff), same
// origin, a written reason, an audit event in the same transaction. An order that carries proof of a Stripe payment (or one on hold) cannot be changed from here:
// its lines and totals are what Stripe was asked to charge (lib/order-payment-evidence.ts).
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  let adminId = ''
  try {
    adminId = await requireRole(['admin'])
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 })
  }
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid request origin.', code: 'INVALID_ORIGIN' }, { status: 403 })

  try {
    const { orderId, itemId } = await params
    const payload = payloadSchema.parse(await req.json())
    const reason = requireAdminReason(payload.reason)

    const result = await prisma.$transaction(async (tx) => {
      const evidence = await loadStripeEvidence(tx, orderId)
      if (!evidence) throw Object.assign(new Error('Order item not found.'), { status: 404 })
      assertNoStripeEvidence(evidence)
      const item = await tx.printOrderItem.findFirst({
        where: { id: itemId, orderId },
        select: {
          id: true,
          orderId: true,
          quantity: true,
          unitPriceCents: true,
          totalCents: true,
        },
      })
      if (!item) {
        throw Object.assign(new Error('Order item not found.'), { status: 404 })
      }

      const nextTotalCents = item.unitPriceCents * payload.quantity
      const deltaCents = nextTotalCents - item.totalCents

      const updatedItem = await tx.printOrderItem.update({
        where: { id: item.id },
        data: {
          quantity: payload.quantity,
          totalCents: nextTotalCents,
        },
        select: {
          id: true,
          quantity: true,
          unitPriceCents: true,
          totalCents: true,
        },
      })

      const updatedOrder = await tx.printOrder.update({
        where: { id: orderId },
        data: {
          subtotalCents: { increment: deltaCents },
          totalCents: { increment: deltaCents },
        },
        select: {
          id: true,
          subtotalCents: true,
          totalCents: true,
        },
      })

      await recordAdminAuditEvent({
        adminId,
        action: 'admin.order.item_quantity',
        targetType: 'order',
        targetId: orderId,
        ...getAdminAuditRequestMeta(req),
        metadata: {
          reason, itemId: item.id, quantity: { from: item.quantity, to: payload.quantity },
          totalCents: { from: updatedOrder.totalCents - deltaCents, to: updatedOrder.totalCents },
        },
      }, tx)

      return { item: updatedItem, order: updatedOrder }
    })

    await syncLinkedJobsFromOrder(orderId)

    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    if (e instanceof AdminActionError) return NextResponse.json({ error: e.message, code: e.code, details: e.details }, { status: e.status })
    const status = typeof e?.status === 'number' ? e.status : 400
    return NextResponse.json({ error: e?.message || 'Invalid request.' }, { status })
  }
}
