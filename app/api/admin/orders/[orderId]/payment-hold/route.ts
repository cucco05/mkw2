import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/app/api/admin/_utils'
import { isSameOriginRequest } from '@/lib/csrf'
import { getAdminAuditRequestMeta } from '@/lib/admin-audit'
import { PaymentHoldError, PAYMENT_HOLD_REASON_MAX_LENGTH, resolvePaymentHold } from '@/lib/payment-hold'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ orderId: string }> }

// POST /api/admin/orders/<id>/payment-hold - an administrator's recorded decision about a payment that is on hold (lib/payment-hold.ts).
//   outcome "no_charge": nothing was charged; the order is cancelled and the customer may pay again.
//   outcome "accepted":  the money is collected and the reason it was held has been dealt with.
// Administrators only (not staff); a written reason is required; the decision, the reason and what Stripe said are kept on the order and in the audit log.
const bodySchema = z.object({
  outcome: z.enum(['no_charge', 'accepted']),
  reason: z.string().max(PAYMENT_HOLD_REASON_MAX_LENGTH),
  acknowledgeUnverified: z.boolean().optional(),
}).strict()

async function handlePost(req: NextRequest, { params }: Context) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid request origin.', code: 'INVALID_ORIGIN' }, { status: 403 })
  let adminId = ''
  try { adminId = await requireRole(['admin']) } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 })
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.', code: 'INVALID_REQUEST' }, { status: 400 })
  const { orderId } = await params
  try {
    const result = await resolvePaymentHold({
      orderId,
      adminId,
      outcome: parsed.data.outcome,
      reason: parsed.data.reason,
      acknowledgeUnverified: parsed.data.acknowledgeUnverified,
      audit: getAdminAuditRequestMeta(req),
    })
    return NextResponse.json({ ok: true, order: result.order, stripeCheck: result.stripeCheck })
  } catch (err: any) {
    if (err instanceof PaymentHoldError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    await captureError(err, { category: 'payment_hold', route: '/api/admin/orders/[orderId]/payment-hold' })
    return NextResponse.json({ error: 'The decision could not be recorded.', code: 'FAILED' }, { status: 500 })
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/admin/orders/[orderId]/payment-hold' })
