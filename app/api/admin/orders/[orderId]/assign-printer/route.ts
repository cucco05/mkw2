import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { rejectCrossOrigin, requireAdmin } from '@/app/api/admin/_utils'
import { z } from 'zod'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { ASSIGN_PRINTER_STATUSES } from '@/lib/order-payment-policy'
import { releaseErrorResponse, withReleaseLock } from '@/lib/production-release'

const payloadSchema = z.object({
  printerId: z.string().min(1).nullable().optional(),
  amsTrayMap: z.array(z.object({ color: z.string(), tray: z.number() })).optional(),
})

type RouteParams = { params: Promise<{ orderId: string }> }

function mergeMetadata(base: any, patch: Record<string, any>) {
  const existing = base && typeof base === 'object' && !Array.isArray(base) ? base : {}
  return { ...existing, ...patch }
}

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
    const assigning = Boolean(payload.printerId)
    const requestMeta = getAdminAuditRequestMeta(req)

    // Putting an order on a printer needs a released order in a status where a printer makes sense; taking the printer off, or only saving the AMS tray map,
    // does not. Decided and written under the lock on the order, on the facts read after it.
    const updated = await withReleaseLock(orderId, 'assign-printer', async ({ tx, order, decision }) => {
      const data: Prisma.PrintOrderUncheckedUpdateInput = {}
      // The assignment fields are touched only when the request is about the printer: a request that only carries the tray map must not erase who assigned it.
      if (payload.printerId !== undefined) {
        data.printerId = payload.printerId
        data.printerAssignedAt = payload.printerId ? new Date() : null
        data.printerAssignedBy = payload.printerId ? adminId : null
      }
      // merged into the metadata read under the lock, so markers written by someone else a moment ago are kept
      if (payload.amsTrayMap) data.metadata = mergeMetadata(order.metadata, { amsTrayMap: payload.amsTrayMap }) as Prisma.InputJsonValue
      const row = await tx.printOrder.update({
        where: { id: orderId },
        data,
        select: { id: true, printerId: true, printerAssignedAt: true, printerAssignedBy: true, metadata: true },
      })
      if (payload.printerId !== undefined) {
        await recordAdminAuditEvent({
          adminId,
          action: payload.printerId ? 'admin.order.printer.assign' : 'admin.order.printer.unassign',
          targetType: 'print_order',
          targetId: orderId,
          requestMethod: requestMeta.requestMethod,
          requestPath: requestMeta.requestPath,
          requestIp: requestMeta.requestIp,
          userAgent: requestMeta.userAgent,
          metadata: { printerId: payload.printerId, previousPrinterId: order.printerId, status: order.status, releaseState: decision.state, releaseBasis: decision.basis },
        }, tx)
      }
      return row
    }, assigning ? { require: 'released', allowStatuses: ASSIGN_PRINTER_STATUSES } : { require: 'none' })

    return NextResponse.json({ order: updated })
  } catch (e: any) {
    const refusal = releaseErrorResponse(e)
    if (refusal) return refusal
    return NextResponse.json({ error: e.message || 'Invalid request' }, { status: 400 })
  }
}
