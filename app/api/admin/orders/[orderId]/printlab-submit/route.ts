import { NextResponse } from 'next/server'
import { rejectCrossOrigin, requireAdmin } from '@/app/api/admin/_utils'
import { submitOrderToPrintLab } from '@/lib/printlab-order-submit'
import { releaseErrorResponse } from '@/lib/production-release'

type RouteParams = { params: Promise<{ orderId: string }> }

export async function POST(req: Request, { params }: RouteParams) {
  let adminId: string
  try {
    adminId = await requireAdmin()
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 })
  }
  const crossOrigin = rejectCrossOrigin(req)
  if (crossOrigin) return crossOrigin

  try {
    const { orderId } = await params
    const result = await submitOrderToPrintLab(orderId, { actor: 'makerworks_admin', adminId, throwOnFailure: true })
    return NextResponse.json(result)
  } catch (e: any) {
    const refusal = releaseErrorResponse(e)
    if (refusal) return refusal
    return NextResponse.json({ error: e.message || 'Failed to submit order to PrintLab.', ...(e.code ? { code: e.code } : {}) }, { status: e.status || 400 })
  }
}
