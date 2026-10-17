import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rejectCrossOrigin, requireRole } from '../../_utils'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { machineInputSchema } from '@/lib/printer-machines'

export const dynamic = 'force-dynamic'

// Change a machine. Only the fields sent are changed; the result is checked as a whole (the same rules as when a machine is created) before saving.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let adminId: string
  try { adminId = await requireRole(['admin']) } catch (e: any) { return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 }) }
  const crossOrigin = rejectCrossOrigin(req)
  if (crossOrigin) return crossOrigin
  const { id } = await params
  const stored = await prisma.printerMachine.findUnique({ where: { id } })
  if (!stored) return NextResponse.json({ error: 'Machine not found' }, { status: 404 })
  const patch = await req.json().catch(() => null)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return NextResponse.json({ error: 'Invalid machine' }, { status: 400 })
  const merged = {
    key: stored.key, label: stored.label, isActive: stored.isActive, buildXmm: stored.buildXmm, buildYmm: stored.buildYmm, buildZmm: stored.buildZmm,
    marginXYmm: stored.marginXYmm, marginZmm: stored.marginZmm, supportMarginXYmm: stored.supportMarginXYmm, nozzleDiameterMm: stored.nozzleDiameterMm,
    minFeatureMm: stored.minFeatureMm, maxSupportRatio: stored.maxSupportRatio, allowedMaterials: stored.allowedMaterials, allowedFinishes: stored.allowedFinishes, notes: stored.notes,
    ...(patch as Record<string, unknown>),
  }
  const parsed = machineInputSchema.safeParse(merged)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid machine', issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, { status: 400 })
  const data = parsed.data
  if (data.key !== stored.key && await prisma.printerMachine.findUnique({ where: { key: data.key }, select: { id: true } })) {
    return NextResponse.json({ error: 'A machine with this key already exists' }, { status: 409 })
  }
  const machine = await prisma.printerMachine.update({ where: { id }, data: { ...data, minFeatureMm: data.minFeatureMm ?? null, maxSupportRatio: data.maxSupportRatio ?? null, notes: data.notes ?? null } })
  await recordAdminAuditEvent({ adminId, action: 'printer_machine.update', targetType: 'PrinterMachine', targetId: id, ...getAdminAuditRequestMeta(req), metadata: { key: machine.key, before: stored, after: data } as any })
  return NextResponse.json({ machine })
}
