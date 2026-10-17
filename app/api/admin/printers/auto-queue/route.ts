import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rejectCrossOrigin, requireAdmin } from '../../_utils'
import { fetchPrintLabStatus, isPrintLabConfigured } from '@/lib/printlab'
import { releasedOrderWhere } from '@/lib/order-payment-policy'
import { ProductionReleaseError, withReleaseLock } from '@/lib/production-release'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'

export const dynamic = 'force-dynamic'

// How many of the oldest queued orders are tried for one printer before giving up (the ones refused at the last moment are skipped, not retried).
const CANDIDATES_PER_PRINTER = 25

function isBusy(status: any) {
  const print = status?.job || status?.print || status?.printer?.print || status || {}
  const state = String(print.state || print.gcode_state || print.gcode_status || '').toLowerCase()
  if (!state) return false
  return ['printing', 'paused', 'running', 'busy'].some((token) => state.includes(token))
}

export async function POST(req: NextRequest) {
  let adminId = ''
  try { adminId = await requireAdmin() } catch (e: any) { return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 }) }
  const crossOrigin = rejectCrossOrigin(req)
  if (crossOrigin) return crossOrigin
  const requestMeta = getAdminAuditRequestMeta(req)
  try {
    const printers = await prisma.printer.findMany({ where: { active: true }, orderBy: { name: 'asc' } })
    const assignments: Array<{ printerId: string; orderId: string }> = []
    let skipped = 0
    for (const printer of printers) {
      if (printer.status === 'maintenance' || printer.status === 'offline') continue
      if (printer.status === 'printing') continue
      if ((printer.provider === 'printlab' || printer.provider === 'bambu-view') && await isPrintLabConfigured()) {
        try {
          const status = await fetchPrintLabStatus(printer.externalId || printer.id)
          if (isBusy(status)) continue
        } catch {
          continue
        }
      }
      // The database filter only PICKS candidates (it can not see everything the rule sees); each one is decided again under the lock on the order, on the facts
      // read after it, and the first that is still queued, still without a printer and still released gets this printer. Two clicks at once can not give one order
      // two printers, and an order whose payment was put on hold a moment ago is not assigned.
      const candidates = await prisma.printOrder.findMany({
        where: { AND: [{ status: 'queued', printerId: null }, releasedOrderWhere(new Date())] },
        orderBy: { createdAt: 'asc' },
        take: CANDIDATES_PER_PRINTER,
        select: { id: true },
      })
      if (candidates.length === 0) break
      let assigned = false
      for (const candidate of candidates) {
        try {
          const done = await withReleaseLock(candidate.id, 'auto-queue', async ({ tx, order, decision }) => {
            if (order.status !== 'queued' || order.printerId) return false
            await tx.printOrder.update({
              where: { id: order.id },
              data: { printerId: printer.id, printerAssignedAt: new Date(), printerAssignedBy: adminId },
            })
            await recordAdminAuditEvent({
              adminId,
              action: 'admin.order.printer.auto_assign',
              targetType: 'print_order',
              targetId: order.id,
              requestMethod: requestMeta.requestMethod,
              requestPath: requestMeta.requestPath,
              requestIp: requestMeta.requestIp,
              userAgent: requestMeta.userAgent,
              metadata: { printerId: printer.id, releaseState: decision.state, releaseBasis: decision.basis },
            }, tx)
            return true
          }, { require: 'released' })
          if (done) {
            assignments.push({ printerId: printer.id, orderId: candidate.id })
            assigned = true
            break
          }
          skipped += 1
        } catch (err) {
          if (err instanceof ProductionReleaseError) { skipped += 1; continue }
          throw err
        }
      }
      if (!assigned) break
    }
    return NextResponse.json({ ok: true, assignments, skipped })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Auto-queue failed' }, { status: 400 })
  }
}
