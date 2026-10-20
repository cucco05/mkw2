import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { FulfillmentStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireAdmin, requireRole } from '@/app/api/admin/_utils'
import { isSameOriginRequest } from '@/lib/csrf'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { AdminActionError, assertNoStripeEvidence, loadStripeEvidence, requireAdminReason } from '@/lib/order-payment-evidence'
import { serializeJob, type JobWithUser } from '@/app/api/admin/orderworks/jobs/_helpers'
import { sendAdminPushNotification } from '@/lib/push'
import { syncOrderStatusFromFulfillment } from '@/lib/orderworks-sync'
import { createOrderFromJobForm, recordAttestedReceipt, type JobPaymentMode, type ReceivedVia } from '@/lib/orders'
import { adminPaymentNotificationTitle } from '@/lib/order-payment-policy'
import { releaseErrorResponse } from '@/lib/production-release'
import {
  isManualPaymentMethod,
  isPaidPaymentStatus,
  normalizePaymentMethod,
  normalizePaymentStatus,
} from '@/lib/orderworks-status'
import { incrementMetric } from '@/lib/observability-metrics'
import { withRequestObservability } from '@/lib/request-observability'
import { generateOrderReceiptBestEffort } from '@/lib/receipts/order-receipts'

const patchSchema = z.object({
  status: z.enum(['pending', 'sent']).optional(),
  paymentMethod: z.string().max(120).optional().nullable(),
  paymentStatus: z.string().max(120).optional().nullable(),
  fulfillmentStatus: z.nativeEnum(FulfillmentStatus).optional(),
  fulfilledAt: z.union([z.string(), z.date(), z.null()]).optional(),
  // step 4.6: the written reason that any change of a PAYMENT field needs (kept in the audit log and, for a payment taken by hand, on the order)
  reason: z.string().max(600).optional(),
  // step 4.6, S6: how the money of a payment registered by hand was RECEIVED (cash or a bank transfer) and, for a transfer, the reference of the bank statement. The
  // amount and the currency are never typed: they are the order's.
  receivedVia: z.enum(['cash', 'bank_transfer']).optional(),
  reference: z.string().trim().max(120).optional(),
})

type Params = { params: Promise<{ paymentIntentId: string }> }

// the amount of a payment attested by hand is the job's (and the order's) total - never typed
const updated0AmountCents = (job: { paymentMethod?: string | null; totalCents: number }) => (job.paymentMethod === 'comped' ? 0 : job.totalCents)

function parseFulfilledAt(explicit: unknown): Date | null | undefined {
  if (explicit === undefined) return undefined
  if (explicit === null || explicit === '') return null
  if (explicit instanceof Date) return explicit
  const date = new Date(String(explicit))
  return Number.isNaN(date.getTime()) ? null : date
}

function resolveFulfilledAt(
  explicit: unknown,
  nextStatus: FulfillmentStatus | undefined,
  currentStatus: FulfillmentStatus,
  currentValue: Date | null,
): Date | null | undefined {
  const parsed = parseFulfilledAt(explicit)
  if (parsed !== undefined) {
    return parsed
  }
  if (!nextStatus || nextStatus === currentStatus) return undefined
  if (nextStatus === 'picked_up' || nextStatus === 'shipped') {
    return currentValue ?? new Date()
  }
  if (nextStatus === 'pending' || nextStatus === 'ready') {
    return null
  }
  return undefined
}

export const dynamic = 'force-dynamic'

// PATCH /api/jobs/<id> - the administrator's OrderWorks job form.
//   * Fulfilment and job status (picked up, shipped, sent): administrators and staff, as before.
//   * ANY change of the payment fields (status or method) is an accountable decision (step 4.6, D8): administrators only (not staff), same origin, a written
//     reason, and an audit event written in the same transaction as the change. A payment can be put on a job in only two ways, and they stay DISTINCT:
//       - a CARD payment (or any non-manual method) is confirmed by Stripe or it is not paid: the order made from the job starts UNPAID and only the verification
//         with Stripe can mark it paid. A typed identifier that is not a Stripe PaymentIntent can never be declared paid;
//       - a payment taken OUTSIDE Stripe (cash, invoice, purchase order, PayPal, no-charge) is REGISTERED by the administrator: the order gets
//         `metadata.manualPayment = { by, at, reason, method }` and never a Stripe id, a payment date or Stripe data.
//     A job whose order already carries proof of a Stripe payment (or one on hold) cannot have its payment fields changed from here.
async function handlePatch(req: Request, { params }: Params) {
  const { paymentIntentId } = await params
  let actorId = ''
  try {
    actorId = await requireAdmin()
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unauthorized' }, { status: err.status || 401 })
  }
  // every change of a job form (fulfilment, status, payment) goes through the session cookie: only from this site
  if (!isSameOriginRequest(req as NextRequest)) return NextResponse.json({ error: 'Invalid request origin.', code: 'INVALID_ORIGIN' }, { status: 403 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 })
  }
  const payload = parsed.data
  const touchesPayment = payload.paymentStatus !== undefined || payload.paymentMethod !== undefined
  let reason = ''
  if (touchesPayment) {
    try { actorId = await requireRole(['admin']) } catch (err: any) {
      return NextResponse.json({ error: err.status === 403 ? 'Only administrators can change the payment of a job.' : (err.message || 'Unauthorized'), code: err.status === 403 ? 'ADMIN_ONLY' : undefined }, { status: err.status || 401 })
    }
    try { reason = requireAdminReason(payload.reason) } catch (err: any) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status || 400 })
    }
  }
  const job = await prisma.jobForm.findUnique({
    where: { paymentIntentId },
    include: { user: { select: { id: true, name: true, email: true } } },
  })
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  const previousPaymentStatus = job.paymentStatus
  const previousPaymentMethod = job.paymentMethod

  const updateData: Prisma.JobFormUpdateInput = {}
  if (payload.status) updateData.status = payload.status
  const paymentMethod = normalizePaymentMethod(payload.paymentMethod)
  if (paymentMethod !== undefined) updateData.paymentMethod = paymentMethod
  const paymentStatus = normalizePaymentStatus(payload.paymentStatus)
  if (paymentStatus !== undefined) updateData.paymentStatus = paymentStatus
  if (payload.fulfillmentStatus) updateData.fulfillmentStatus = payload.fulfillmentStatus
  const fulfilledAt = resolveFulfilledAt(payload.fulfilledAt, payload.fulfillmentStatus, job.fulfillmentStatus, job.fulfilledAt)
  if (fulfilledAt !== undefined) updateData.fulfilledAt = fulfilledAt

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'No changes supplied' }, { status: 400 })
  }

  // ---- the payment decision (D8) -----------------------------------------------------------------------------------------------------------------
  let paymentMode: JobPaymentMode | null = null
  let existingOrderId: string | null = null
  if (touchesPayment) {
    const nextStatus = (paymentStatus !== undefined ? paymentStatus : job.paymentStatus) ?? null
    const nextMethod = (paymentMethod !== undefined ? paymentMethod : job.paymentMethod) ?? null
    try {
      // proof of a Stripe payment on the order made from this job: its payment can not be edited from here
      const linked = await prisma.printOrder.findMany({
        where: { OR: [{ metadata: { path: ['paymentIntentId'], equals: paymentIntentId } }, { metadata: { path: ['jobFormId'], equals: job.id } }] },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      })
      existingOrderId = linked[0]?.id ?? null
      for (const order of linked) {
        const evidence = await loadStripeEvidence(prisma, order.id)
        if (evidence) assertNoStripeEvidence(evidence)
      }
      if (isPaidPaymentStatus(nextStatus)) {
        if (isManualPaymentMethod(nextMethod)) {
          const method = String(normalizePaymentMethod(nextMethod))
          if (nextStatus !== 'paid' && nextStatus !== 'free') {
            throw new AdminActionError('PAYMENT_STATUS_NOT_MANUAL', 'A payment taken outside Stripe can only be registered as paid (or as no-charge).', 409)
          }
          if (paymentIntentId.startsWith('pi_')) {
            throw new AdminActionError('MANUAL_PAYMENT_WITH_STRIPE_ID', 'This job carries a Stripe identifier: a payment taken outside Stripe cannot be registered on it.', 409)
          }
          // (step 4.6, S6) a PayPal capture is verified by the server or it is not paid: an administrator's word is not a PayPal payment
          if (method === 'paypal') {
            throw new AdminActionError('PAYPAL_NOT_ATTESTABLE', 'A PayPal payment can not be registered by hand: it is paid when the server has verified the capture with PayPal.', 409)
          }
          // an invoice or a purchase order is a CREDIT, not money: it is "paid" only through the receipt of the money that arrived for it
          let receivedVia: ReceivedVia
          let reference: string | null = null
          if (method === 'comped') {
            if (nextStatus !== 'free') throw new AdminActionError('NO_CHARGE_IS_FREE', 'A no-charge order is registered as "free".', 409)
            receivedVia = 'none'
          } else {
            if (nextStatus !== 'paid') throw new AdminActionError('PAYMENT_STATUS_NOT_MANUAL', 'Money received outside Stripe is registered as "paid"; "free" is the no-charge decision.', 409)
            if (method === 'cash') {
              if (payload.receivedVia && payload.receivedVia !== 'cash') throw new AdminActionError('RECEIPT_METHOD_MISMATCH', 'A cash sale is received in cash.', 409)
              receivedVia = 'cash'
            } else {
              if (!payload.receivedVia) {
                throw new AdminActionError('INVOICE_OR_PO_IS_CREDIT', 'An invoice or a purchase order is a credit, not a payment: say how the money was RECEIVED (cash or a bank transfer, with its reference) to register it as paid. To produce on credit, authorize the order as a commercial credit instead.', 409)
              }
              receivedVia = payload.receivedVia
            }
            if (receivedVia === 'bank_transfer') {
              reference = (payload.reference ?? '').trim()
              if (reference.length < 1) throw new AdminActionError('RECEIPT_REFERENCE_REQUIRED', 'A bank transfer needs the reference of the bank statement (reference).', 400)
            } else if (payload.reference) {
              reference = payload.reference.trim() || null
            }
          }
          paymentMode = { kind: 'manual', by: actorId, at: new Date().toISOString(), reason, method, receivedVia, reference }
        } else {
          // a card payment is confirmed by Stripe or it is not paid; a typed identifier is not a payment
          if (!paymentIntentId.startsWith('pi_')) {
            throw new AdminActionError('CARD_PAYMENT_NOT_VERIFIABLE', 'A card payment can only be marked paid by Stripe\'s own confirmation, and this job has no Stripe payment identifier. Register a payment taken outside Stripe (cash, invoice, purchase order) or attach the Stripe payment to the order.', 409)
          }
          paymentMode = { kind: 'stripe' }
          // the word of the administrator is not the payment: the job keeps the status Stripe confirms (set below, from the order)
          delete updateData.paymentStatus
        }
      }
    } catch (err: any) {
      if (err instanceof AdminActionError) return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: err.status })
      throw err
    }
  }

  // (step 4.6, S6) a payment attested by an administrator on an order that ALREADY EXISTS is written on that order first - under its lock, with its own audit event - and the
  // job follows: if the order refuses (a Stripe payment appeared, a receipt is already registered) nothing at all has changed and the administrator is told why. For an order
  // that does not exist yet, the receipt is part of making it (after the job is updated, as before).
  let attestedOrderId: string | null = null
  if (paymentMode?.kind === 'manual' && existingOrderId) {
    try {
      await recordAttestedReceipt({
        orderId: existingOrderId, adminId: actorId, reason, method: paymentMode.method as 'cash' | 'invoice' | 'po' | 'comped', receivedVia: paymentMode.receivedVia, reference: paymentMode.reference ?? null,
        audit: getAdminAuditRequestMeta(req), auditDetail: { jobPaymentIntentId: paymentIntentId },
      })
      attestedOrderId = existingOrderId
    } catch (err: any) {
      if (err instanceof AdminActionError) return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: err.status })
      const refusal = releaseErrorResponse(err)
      if (refusal) return refusal
      throw err
    }
  }

  // the change and its audit event are written together: a payment decision never exists without its trace
  const updated = (await prisma.$transaction(async (tx) => {
    const row = Object.keys(updateData).length > 0
      ? await tx.jobForm.update({ where: { paymentIntentId }, data: updateData, include: { user: { select: { id: true, name: true, email: true } } } })
      : await tx.jobForm.findUniqueOrThrow({ where: { paymentIntentId }, include: { user: { select: { id: true, name: true, email: true } } } })
    if (touchesPayment) {
      await recordAdminAuditEvent({
        adminId: actorId,
        action: 'admin.job.payment',
        targetType: 'job_form',
        targetId: job.id,
        ...getAdminAuditRequestMeta(req),
        metadata: {
          paymentIntentId, reason,
          previous: { paymentStatus: previousPaymentStatus ?? null, paymentMethod: previousPaymentMethod ?? null },
          requested: { paymentStatus: payload.paymentStatus ?? null, paymentMethod: payload.paymentMethod ?? null },
          decision: paymentMode?.kind ?? 'bookkeeping',
          ...(paymentMode?.kind === 'manual' ? { receivedVia: paymentMode.receivedVia, reference: paymentMode.reference ?? null, amountCents: updated0AmountCents(job), currency: job.currency } : {}),
        },
      }, tx)
    }
    return row
  })) as JobWithUser
  let result: JobWithUser = updated

  try {
    const paymentStatusChanged = payload.paymentStatus !== undefined && updated.paymentStatus !== previousPaymentStatus
    const paymentMethodChanged = payload.paymentMethod !== undefined && updated.paymentMethod !== previousPaymentMethod
    if (updated.fulfillmentStatus) {
      await syncOrderStatusFromFulfillment(paymentIntentId, updated.fulfillmentStatus)
    }
    let linkedOrderId: string | null = null
    if (touchesPayment && paymentMode) {
      const order = attestedOrderId ? { id: attestedOrderId } : await createOrderFromJobForm(updated, { payment: paymentMode })
      linkedOrderId = order?.id || null
      if (order && paymentMode.kind === 'stripe') {
        // the job mirrors what the order says after the verification with Stripe, never what was typed
        const current = await prisma.printOrder.findUnique({ where: { id: order.id }, select: { paymentStatus: true } })
        if (current && current.paymentStatus !== updated.paymentStatus) {
          result = (await prisma.jobForm.update({ where: { paymentIntentId }, data: { paymentStatus: current.paymentStatus }, include: { user: { select: { id: true, name: true, email: true } } } })) as JobWithUser
        }
      }
    }
    if (!linkedOrderId && (paymentStatusChanged || paymentMethodChanged)) {
      const linkedOrder = await prisma.printOrder.findFirst({
        where: {
          OR: [
            { stripePaymentIntentId: paymentIntentId },
            { metadata: { path: ['paymentIntentId'], equals: paymentIntentId } },
            { metadata: { path: ['stripe', 'paymentIntentId'], equals: paymentIntentId } },
          ],
        },
        select: { id: true },
      } as any)
      linkedOrderId = linkedOrder?.id || null
    }
    if (linkedOrderId && (paymentStatusChanged || paymentMethodChanged)) {
      await generateOrderReceiptBestEffort(linkedOrderId, 'adminJobPaymentUpdate')
    }
    if (paymentStatusChanged || paymentMethodChanged) {
      if (updated.paymentStatus && ['failed', 'canceled', 'cancelled'].includes(updated.paymentStatus)) {
        incrementMetric('payment_failures_total', 1, { source: 'admin_job_patch', reason: updated.paymentStatus })
      }
      const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')
      await sendAdminPushNotification({
        title: adminPaymentNotificationTitle(updated.paymentMethod, updated.paymentStatus, { created: false }),
        body: `Intent ${paymentIntentId} - ${updated.paymentMethod || 'unknown'} ${updated.paymentStatus ? `(${updated.paymentStatus})` : ''}`.trim(),
        url: `${baseUrl}/admin/jobs`,
        tag: `payment:${paymentIntentId}`,
        data: { paymentIntentId, paymentMethod: updated.paymentMethod, paymentStatus: updated.paymentStatus || undefined },
      })
    }
  } catch (notifyErr) {
    console.error('Admin push notification failed for job update:', notifyErr)
  }

  return NextResponse.json({ ok: true, job: serializeJob(result) })
}

export const PATCH = withRequestObservability(handlePatch, { routeName: '/api/jobs/[paymentIntentId]' })
