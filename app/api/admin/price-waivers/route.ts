import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/app/api/admin/_utils'
import { isSameOriginRequest } from '@/lib/csrf'
import { getAdminAuditRequestMeta } from '@/lib/admin-audit'
import { consumeFixedWindow } from '@/lib/rate-limit'
import { grantWaiver, isWaiverAdmin, listWaiverOverview, WaiverError, WAIVER_REASON_MAX_LENGTH } from '@/lib/minimum-waivers'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'

export const dynamic = 'force-dynamic'

// Authorised, traced exceptions to the shop's minimum price per unit (step 4.6, lib/minimum-waivers.ts). Administrators only - not staff - and, when
// PRICE_WAIVER_ADMIN_IDS is set, only the administrators named there. A waiver is for ONE model or ONE product, needs a written reason, and is written
// together with its audit event. Nothing a customer sends can reach this: the price engine reads the waivers from the database by itself.
const grantSchema = z.object({
  target: z.object({ type: z.enum(['model', 'product']), id: z.string().min(1).max(64) }).strict(),
  minimumPriceCents: z.number().int().min(0).max(100_000_000),
  reason: z.string().max(WAIVER_REASON_MAX_LENGTH * 2),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict()

type Guarded = { ok: true; adminId: string } | { ok: false; response: NextResponse }

async function guard(req: NextRequest, write: boolean): Promise<Guarded> {
  if (write && !isSameOriginRequest(req)) return { ok: false, response: NextResponse.json({ error: 'Invalid request origin.', code: 'INVALID_ORIGIN' }, { status: 403 }) }
  let adminId = ''
  try { adminId = await requireRole(['admin']) } catch (e: any) {
    return { ok: false, response: NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 }) }
  }
  if (!isWaiverAdmin(adminId)) return { ok: false, response: NextResponse.json({ error: 'You are not allowed to manage price waivers.', code: 'WAIVER_NOT_ALLOWED' }, { status: 403 }) }
  if (write) {
    const limit = await consumeFixedWindow(`price-waiver:${adminId}`, { windowMs: 60_000, max: 30 })
    if (!limit.allowed) return { ok: false, response: NextResponse.json({ error: 'Too many requests.', code: 'RATE_LIMITED', retryAfterSeconds: limit.retryAfterSeconds }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds ?? 60) } }) }
  }
  return { ok: true, adminId }
}

async function handleGet(req: NextRequest) {
  const checked = await guard(req, false)
  if (!checked.ok) return checked.response
  return NextResponse.json(await listWaiverOverview(), { headers: { 'Cache-Control': 'no-store' } })
}

async function handlePost(req: NextRequest) {
  const checked = await guard(req, true)
  if (!checked.ok) return checked.response
  const parsed = grantSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.', code: 'INVALID_REQUEST' }, { status: 400 })
  try {
    const waiver = await grantWaiver({
      adminId: checked.adminId,
      target: parsed.data.target.type === 'model' ? { modelId: parsed.data.target.id } : { productTemplateId: parsed.data.target.id },
      minimumPriceCents: parsed.data.minimumPriceCents,
      reason: parsed.data.reason,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      audit: getAdminAuditRequestMeta(req),
    })
    return NextResponse.json({ ok: true, waiver: { id: waiver.id, minimumPriceCents: waiver.minimumPriceCents } }, { status: 201 })
  } catch (err: any) {
    if (err instanceof WaiverError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    await captureError(err, { category: 'price_waiver', route: '/api/admin/price-waivers' })
    return NextResponse.json({ error: 'The waiver could not be recorded.', code: 'FAILED' }, { status: 500 })
  }
}

export const GET = withRequestObservability(handleGet, { routeName: '/api/admin/price-waivers' })
export const POST = withRequestObservability(handlePost, { routeName: '/api/admin/price-waivers' })
