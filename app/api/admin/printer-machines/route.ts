import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireRole } from '../_utils'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { MATERIAL_OPTIONS } from '@/lib/cartPricing'
import { knownFinishes } from '@/lib/pricing'
import { machineInputSchema } from '@/lib/printer-machines'

export const dynamic = 'force-dynamic'

// The machines that can make the orders (docs/PROGETTO.md, "Stampante iniziale"): their size, margins and the materials and finishes they offer.
// Administrators only (it decides what may be paid online). Changes are recorded in the admin audit log. Machines are deactivated, not deleted,
// so that a mistake is one tick away from being undone.
async function admin() {
  try { return { id: await requireRole(['admin']) } } catch (e: any) { return { response: NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 }) } }
}

export async function GET() {
  const who = await admin()
  if ('response' in who) return who.response
  const machines = await prisma.printerMachine.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] })
  return NextResponse.json({ machines, options: { materials: [...MATERIAL_OPTIONS], finishes: knownFinishes() } }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const who = await admin()
  if ('response' in who) return who.response
  const parsed = machineInputSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid machine', issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, { status: 400 })
  const data = parsed.data
  if (await prisma.printerMachine.findUnique({ where: { key: data.key }, select: { id: true } })) {
    return NextResponse.json({ error: 'A machine with this key already exists' }, { status: 409 })
  }
  const machine = await prisma.printerMachine.create({ data: { ...data, minFeatureMm: data.minFeatureMm ?? null, maxSupportRatio: data.maxSupportRatio ?? null, notes: data.notes ?? null } })
  await recordAdminAuditEvent({ adminId: who.id, action: 'printer_machine.create', targetType: 'PrinterMachine', targetId: machine.id, ...getAdminAuditRequestMeta(req), metadata: { key: machine.key, after: data } as any })
  return NextResponse.json({ machine }, { status: 201 })
}
