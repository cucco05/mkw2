import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/app/api/admin/_utils'
import { isSameOriginRequest } from '@/lib/csrf'
import { getAdminAuditRequestMeta } from '@/lib/admin-audit'
import { consumeFixedWindow } from '@/lib/rate-limit'
import { isWaiverAdmin, revokeWaiver, WaiverError, WAIVER_REASON_MAX_LENGTH } from '@/lib/minimum-waivers'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

// POST /api/admin/price-waivers/<id> - revokes a waiver (administrators only, written reason, audit event in the same transaction). Revoking changes the price
// of FUTURE carts only: orders already made keep theirs (lib/minimum-waivers.ts).
const revokeSchema = z.object({ reason: z.string().max(WAIVER_REASON_MAX_LENGTH * 2) }).strict()

async function handlePost(req: NextRequest, { params }: Context) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid request origin.', code: 'INVALID_ORIGIN' }, { status: 403 })
  let adminId = ''
  try { adminId = await requireRole(['admin']) } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 })
  }
  if (!isWaiverAdmin(adminId)) return NextResponse.json({ error: 'You are not allowed to manage price waivers.', code: 'WAIVER_NOT_ALLOWED' }, { status: 403 })
  const limit = await consumeFixedWindow(`price-waiver:${adminId}`, { windowMs: 60_000, max: 30 })
  if (!limit.allowed) return NextResponse.json({ error: 'Too many requests.', code: 'RATE_LIMITED', retryAfterSeconds: limit.retryAfterSeconds }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds ?? 60) } })
  const parsed = revokeSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.', code: 'INVALID_REQUEST' }, { status: 400 })
  const { id } = await params
  try {
    const waiver = await revokeWaiver({ adminId, waiverId: id, reason: parsed.data.reason, audit: getAdminAuditRequestMeta(req) })
    return NextResponse.json({ ok: true, waiver: { id: waiver.id, revokedAt: waiver.revokedAt } })
  } catch (err: any) {
    if (err instanceof WaiverError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    await captureError(err, { category: 'price_waiver', route: '/api/admin/price-waivers/[id]' })
    return NextResponse.json({ error: 'The revocation could not be recorded.', code: 'FAILED' }, { status: 500 })
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/admin/price-waivers/[id]' })
