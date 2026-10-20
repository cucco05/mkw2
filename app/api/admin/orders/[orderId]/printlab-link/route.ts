import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

import { adminRouteGuards, rejectCrossOrigin } from '@/app/api/admin/_utils'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import {
  fetchPrintLabJob,
  fetchPrintLabSuccessfulGcodes,
} from '@/lib/printlab'
import {
  buildManualPrintLabAttachment,
  findSuccessfulGcodeRecord,
  hasExactPrintLabMaterialUsage,
  mergePrintLabOrderAttachment,
  normalizePrintLabSubmittedJobAttachment,
  normalizeSuccessfulGcodeAttachment,
} from '@/lib/printlab-order-link'
import { printLabSignalOrderStatus } from '@/lib/production'
import { noteUnreleasedSignal, releaseErrorResponse, withReleaseLock } from '@/lib/production-release'
import { maybeConsumeStockForOrder } from '@/lib/stockworks-consumption'
import { withFinancialRevision } from '@/lib/financial-revision'

export const dynamic = 'force-dynamic'

export const printLabOrderLinkRouteOps = {
  fetchPrintLabJob,
  fetchPrintLabSuccessfulGcodes,
  maybeConsumeStockForOrder,
  recordAdminAuditEvent,
  withReleaseLock,
}

const optionalText = z.string().trim().max(500).optional().nullable()

const payloadSchema = z.object({
  mode: z.enum(['submitted_job', 'successful_gcode', 'manual', 'auto']),
  id: z.string().trim().max(200).optional().nullable(),
  note: optionalText,
  manual: z.object({
    printLabJobId: z.string().trim().max(200).optional().nullable(),
    successfulGcodeId: z.string().trim().max(200).optional().nullable(),
    status: z.string().trim().max(100).optional().nullable(),
    printerId: z.string().trim().max(200).optional().nullable(),
    printerName: z.string().trim().max(200).optional().nullable(),
    modelId: z.string().trim().max(200).optional().nullable(),
    modelName: z.string().trim().max(200).optional().nullable(),
    fileName: z.string().trim().max(500).optional().nullable(),
    filePath: z.string().trim().max(1000).optional().nullable(),
    completedAt: z.string().trim().max(100).optional().nullable(),
    note: optionalText,
  }).optional(),
}).superRefine((payload, ctx) => {
  if (payload.mode === 'manual') {
    const manual = payload.manual
    if (!manual?.printLabJobId?.trim() && !manual?.successfulGcodeId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PrintLab job ID or successful G-code ID is required for a manual link.',
        path: ['manual'],
      })
    }
    return
  }

  if (!payload.id?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'PrintLab record ID is required.',
      path: ['id'],
    })
  }
})

type Payload = z.infer<typeof payloadSchema>
type RouteContext = { params: Promise<{ orderId: string }> }

function firstIssueMessage(error: unknown) {
  const issues = (error as any)?.issues
  return Array.isArray(issues) && issues[0]?.message ? String(issues[0].message) : 'Invalid request body.'
}

function statusError(message: string, status: number) {
  return Object.assign(new Error(message), { status })
}

async function buildAttachment(payload: Payload, adminId: string) {
  const context = { adminId, note: payload.note ?? null }

  if (payload.mode === 'manual') {
    return buildManualPrintLabAttachment(payload.manual || {}, context)
  }

  const id = payload.id?.trim()
  if (!id) throw statusError('PrintLab record ID is required.', 400)

  if (payload.mode === 'submitted_job') {
    return normalizePrintLabSubmittedJobAttachment(
      await printLabOrderLinkRouteOps.fetchPrintLabJob(id),
      context,
    )
  }

  if (payload.mode === 'successful_gcode') {
    const record = findSuccessfulGcodeRecord(
      await printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes(),
      id,
    )
    if (!record) throw statusError('PrintLab successful G-code record was not found.', 404)
    return normalizeSuccessfulGcodeAttachment(record, context)
  }

  try {
    return normalizePrintLabSubmittedJobAttachment(
      await printLabOrderLinkRouteOps.fetchPrintLabJob(id),
      context,
    )
  } catch {
    const record = findSuccessfulGcodeRecord(
      await printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes(),
      id,
    )
    if (!record) throw statusError('PrintLab record was not found.', 404)
    return normalizeSuccessfulGcodeAttachment(record, context)
  }
}

async function handleStockworks(orderId: string, attachment: Awaited<ReturnType<typeof buildAttachment>>) {
  if (!hasExactPrintLabMaterialUsage(attachment)) {
    return {
      ok: false,
      warning: 'PrintLab record did not include exact material grams; StockWorks consumption was not triggered by this link.',
    }
  }

  try {
    const consumed = await printLabOrderLinkRouteOps.maybeConsumeStockForOrder(orderId, 'printlab-admin-link')
    return consumed.ok
      ? { ok: true, movements: Number((consumed as any).movements || 0) }
      : { ok: false, warning: String((consumed as any).reason || 'StockWorks consumption was not applied.') }
  } catch (error: any) {
    return { ok: false, warning: error?.message || 'StockWorks consumption failed.' }
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  let adminId: string
  try {
    adminId = await adminRouteGuards.requireAdmin()
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unauthorized' }, { status: error?.status || 401 })
  }
  const crossOrigin = rejectCrossOrigin(req)
  if (crossOrigin) return crossOrigin

  let payload: Payload
  try {
    payload = payloadSchema.parse(await req.json())
  } catch (error) {
    return NextResponse.json({ error: firstIssueMessage(error) }, { status: 400 })
  }

  try {
    const { orderId } = await params
    // what PrintLab says about the job is read first (a call to the outside, never inside the transaction)
    const attachment = await buildAttachment(payload, adminId)
    const requestMeta = getAdminAuditRequestMeta(req)

    // The link is a FACT about the physical world and is always recorded. It changes the order's status only if the order is released to production - decided
    // under the lock on the order, on the facts read after it - and only for the statuses PrintLab is known to send.
    const result = await printLabOrderLinkRouteOps.withReleaseLock(orderId, 'printlab-link', async ({ tx, order, decision }) => {
      const metadata = mergePrintLabOrderAttachment(order.metadata, attachment)
      const wanted = printLabSignalOrderStatus(attachment.status, order.status)
      const status = wanted && decision.released ? wanted : order.status
      await tx.printOrder.update({
        where: { id: order.id },
        data: withFinancialRevision(order, {
          metadata: metadata as Prisma.InputJsonValue,
          ...(status !== order.status ? { status } : {}),
        }),
      })
      if (!decision.released) noteUnreleasedSignal('printlab-link', order.id, decision, { printLabStatus: attachment.status ?? null, wouldHaveBecome: wanted })
      await printLabOrderLinkRouteOps.recordAdminAuditEvent({
        adminId,
        action: 'admin.order.printlab.link',
        targetType: 'print_order',
        targetId: order.id,
        requestMethod: requestMeta.requestMethod,
        requestPath: requestMeta.requestPath,
        requestIp: requestMeta.requestIp,
        userAgent: requestMeta.userAgent,
        metadata: {
          recordType: attachment.recordType,
          printLabJobId: attachment.printLabJobId,
          successfulGcodeId: attachment.successfulGcodeId,
          status: attachment.status,
          statusApplied: status !== order.status,
          releaseState: decision.state,
          releaseBasis: decision.basis,
        },
      }, tx)
      return { id: order.id, status, released: decision.released, releaseState: decision.state }
    }, { require: 'none' })

    // Taking the material out of stock decides for itself whether the order is released (lib/stockworks-consumption.ts).
    const stockworks = await handleStockworks(result.id, attachment)

    return NextResponse.json({
      ok: true,
      attachment,
      order: { id: result.id, status: result.status },
      release: { released: result.released, state: result.releaseState },
      stockworks,
    })
  } catch (error: any) {
    const refusal = releaseErrorResponse(error)
    if (refusal) return refusal
    return NextResponse.json(
      { error: error?.message || 'Failed to link PrintLab record.' },
      { status: error?.status || 400 },
    )
  }
}
