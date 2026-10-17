import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { rejectCrossOrigin, requireRole } from '@/app/api/admin/_utils'
import { prisma } from '@/lib/db'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { mergeStripePaymentIntentReference, stripePaymentAdminOps } from '@/lib/stripe-payments'
import { evaluateAttach, STRIPE_ATTACH_REASON_MIN_LENGTH, type AttachIntent, type AttachProblem } from '@/lib/stripe-attach'
import { withRequestObservability } from '@/lib/request-observability'
import { lockOrderRow } from '@/lib/production-release'

export const dynamic = 'force-dynamic'

const payloadSchema = z.object({
  paymentIntentId: z.string().trim().regex(/^pi_[A-Za-z0-9]+$/, 'A valid Stripe PaymentIntent ID is required.'),
  // why the link is being made (kept in the audit log)
  reason: z.string().trim().min(STRIPE_ATTACH_REASON_MIN_LENGTH, `A written reason of at least ${STRIPE_ATTACH_REASON_MIN_LENGTH} characters is required.`).max(300),
}).strict() // no other field is understood: nothing can ask to skip a check

type Context = { params: Promise<{ orderId: string }> }

function extractLegacyPaymentIntentId(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const raw = (metadata as Record<string, unknown>).paymentIntentId
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

const refusal = (problems: AttachProblem[]) => NextResponse.json({
  error: 'The PaymentIntent can not be linked to this order: ' + problems.map((problem) => problem.message).join(' '),
  code: 'STRIPE_ATTACH_REFUSED',
  failed: problems,
}, { status: 409 })

// POST /api/admin/orders/<id>/stripe-attach - link a Stripe PaymentIntent to an order that has none (step 4.6, S4). Administrators only, from this site, with a written
// reason, an audit event in the same transaction as the link. The identifier typed is a CLAIM: Stripe is asked for the payment, and the link is made only if the payment
// itself says it is for THIS order (lib/stripe-attach.ts). If the specific link can not be proven the answer is 409, nothing is written, and the order stays unpaid.
// There is no bypass; a payment taken outside Stripe is registered on its own path (the manual payment of the job form).
async function handlePost(req: NextRequest, { params }: Context) {
  let adminId = ''
  try { adminId = await requireRole(['admin']) } catch (e: any) {
    return NextResponse.json({ error: e.status === 403 ? 'Only administrators can link a Stripe payment to an order.' : (e.message || 'Unauthorized'), code: e.status === 403 ? 'ADMIN_ONLY' : undefined }, { status: e.status || 401 })
  }
  const crossOrigin = rejectCrossOrigin(req)
  if (crossOrigin) return crossOrigin

  let payload: z.infer<typeof payloadSchema>
  try {
    payload = payloadSchema.parse(await req.json())
  } catch (e: any) {
    const firstIssue = Array.isArray(e?.issues) ? e.issues[0] : null
    return NextResponse.json({ error: firstIssue?.message || 'Invalid request body.' }, { status: 400 })
  }

  const { orderId } = await params
  const requestMeta = getAdminAuditRequestMeta(req)
  const load = (client: Pick<typeof prisma, 'printOrder' | 'paymentAttempt'>) => client.printOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true, status: true, paymentStatus: true, paymentReviewReason: true, totalCents: true, currency: true, stripePaymentIntentId: true, paidAt: true, metadata: true,
      paymentAttempts: { select: { id: true, status: true } },
    },
  })
  const usage = async (client: Pick<typeof prisma, 'printOrder' | 'paymentAttempt'>) => {
    const [orders, attempts] = await Promise.all([
      client.printOrder.findMany({
        where: {
          id: { not: orderId },
          OR: [
            { stripePaymentIntentId: payload.paymentIntentId },
            { metadata: { path: ['stripe', 'paymentIntentId'], equals: payload.paymentIntentId } },
          ],
        },
        select: { id: true },
      }),
      client.paymentAttempt.findMany({ where: { stripePaymentIntentId: payload.paymentIntentId }, select: { id: true } }),
    ])
    return { orderIds: orders.map((entry) => entry.id), attemptIds: attempts.map((entry) => entry.id) }
  }

  const order = await load(prisma)
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  // What Stripe says now. If Stripe can not be asked, nothing is decided and nothing is written.
  let intent: AttachIntent | null = null
  try {
    intent = await stripePaymentAdminOps.retrievePaymentIntent(payload.paymentIntentId) as unknown as AttachIntent
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.code === 'resource_missing') intent = null
    else return NextResponse.json({ error: 'Stripe could not be asked about that PaymentIntent, so it was not linked. Try again.', code: 'STRIPE_UNAVAILABLE' }, { status: 502 })
  }

  const first = evaluateAttach({ requestedId: payload.paymentIntentId, intent, order, usedElsewhere: await usage(prisma) })
  if (!first.ok) {
    try {
      await recordAdminAuditEvent({
        adminId, action: 'admin.order.stripe_attach_refused', targetType: 'print_order', targetId: orderId, ...requestMeta,
        metadata: { paymentIntentId: payload.paymentIntentId, reason: payload.reason, failed: first.problems.map((problem) => problem.check) },
      })
    } catch { /* the refusal below is what matters */ }
    return refusal(first.problems)
  }

  const priorPaymentIntentId = extractLegacyPaymentIntentId(order.metadata)
  const linkedJob = await prisma.jobForm.findFirst({
    where: {
      OR: [
        { metadata: { path: ['orderId'], equals: orderId } },
        ...(priorPaymentIntentId ? [{ paymentIntentId: priorPaymentIntentId }] : []),
      ],
    },
    select: { id: true, paymentIntentId: true, paymentMethod: true },
    orderBy: { createdAt: 'desc' },
  })

  // The link, the job form and the audit event are written together, under the lock on the order, after the checks were made AGAIN on the facts read under the lock.
  try {
    await prisma.$transaction(async (tx) => {
      await lockOrderRow(tx, orderId)
      const fresh = await load(tx as any)
      if (!fresh) throw Object.assign(new Error('Order not found'), { status: 404 })
      const again = evaluateAttach({ requestedId: payload.paymentIntentId, intent, order: fresh, usedElsewhere: await usage(tx as any) })
      if (!again.ok) throw Object.assign(new Error('refused'), { problems: again.problems })
      await tx.printOrder.update({
        where: { id: orderId },
        data: {
          stripePaymentIntentId: payload.paymentIntentId,
          metadata: mergeStripePaymentIntentReference(fresh.metadata, payload.paymentIntentId),
        },
      })
      if (linkedJob && linkedJob.paymentIntentId !== payload.paymentIntentId) {
        await tx.jobForm.update({ where: { id: linkedJob.id }, data: { paymentIntentId: payload.paymentIntentId, paymentMethod: 'card' } })
      } else if (linkedJob && linkedJob.paymentMethod !== 'card') {
        await tx.jobForm.update({ where: { id: linkedJob.id }, data: { paymentMethod: 'card' } })
      }
      await recordAdminAuditEvent({
        adminId, action: 'admin.order.stripe_attach', targetType: 'print_order', targetId: orderId, ...requestMeta,
        metadata: { paymentIntentId: payload.paymentIntentId, reason: payload.reason, amountCents: intent?.amount_received ?? null, currency: intent?.currency ?? null, proof: 'metadata.orderId' },
      }, tx)
    })
  } catch (e: any) {
    if (Array.isArray(e?.problems)) return refusal(e.problems)
    if (e?.status === 404) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    if (e?.code === 'P2002') return refusal([{ check: 'not_reused', message: 'That PaymentIntent is already linked to another order.' }])
    return NextResponse.json({ error: e?.message || 'The PaymentIntent could not be linked.' }, { status: 400 })
  }

  // The payment sync verifies the payment again, the way it does for every payment, and only then marks the order paid.
  try {
    const result = await stripePaymentAdminOps.syncStripePaymentIntent(payload.paymentIntentId, 'admin.attach')
    return NextResponse.json({ ok: true, paymentIntentId: payload.paymentIntentId, paymentStatus: result.paymentStatus, updatedOrders: result.updatedOrders })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Stripe sync failed' }, { status: e?.status || 400 })
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/admin/orders/[orderId]/stripe-attach' })
