import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { mergePrintLabCallbackMetadata, printLabSignalOrderStatus } from '@/lib/production'
import { ProductionReleaseError, noteUnreleasedSignal, withReleaseLock } from '@/lib/production-release'
import { withFinancialRevision } from '@/lib/financial-revision'

const callbackSchema = z.object({
  job_id: z.string().min(1).optional(),
  status: z.string().min(1),
  printer_id: z.string().optional().nullable(),
  printer_name: z.string().optional().nullable(),
  queue_item_id: z.string().optional().nullable(),
  successful_gcode_id: z.string().optional().nullable(),
  idempotency_key: z.string().optional().nullable(),
  source_job_id: z.string().optional().nullable(),
  source_order_id: z.string().optional().nullable(),
  model_id: z.string().optional().nullable(),
  model_name: z.string().optional().nullable(),
  completed_at: z.string().optional().nullable(),
  started_at: z.string().optional().nullable(),
  updated_at: z.string().optional().nullable(),
  last_error: z.string().optional().nullable(),
  progress_percent: z.number().optional().nullable(),
  metadata: z.any().optional(),
}).passthrough()

type Params = { params: Promise<{ jobId: string }> }

function timingSafeEqual(a: string, b: string) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function callbackSecret() {
  return (process.env.PRINTLAB_WEBHOOK_SECRET || process.env.MAKERWORKS_INBOUND_SECRET || '').trim()
}

function verifyBearer(req: NextRequest, secret: string) {
  const auth = req.headers.get('authorization') || ''
  return auth.startsWith('Bearer ') && timingSafeEqual(auth.slice(7), secret)
}

function verifySignature(req: NextRequest, rawBody: string, secret: string) {
  const timestamp = req.headers.get('x-makerworks-timestamp') || ''
  const signature = req.headers.get('x-makerworks-signature') || ''
  if (!timestamp || !signature.startsWith('sha256=')) return false
  const parsedDate = new Date(timestamp)
  if (Number.isNaN(parsedDate.getTime())) return false
  if (Math.abs(Date.now() - parsedDate.getTime()) > 5 * 60 * 1000) return false
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return timingSafeEqual(signature.slice('sha256='.length), expected)
}

function readOrderId(payload: z.infer<typeof callbackSchema>) {
  if (payload.source_order_id?.trim()) return payload.source_order_id.trim()
  if (payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)) {
    const raw = payload.metadata.order_id
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: Params) {
  const secret = callbackSecret()
  if (!secret) {
    return NextResponse.json({ error: 'PrintLab webhook secret is not configured.' }, { status: 500 })
  }

  const rawBody = await req.text()
  if (!verifyBearer(req, secret) && !verifySignature(req, rawBody, secret)) {
    return NextResponse.json({ error: 'Invalid PrintLab webhook signature.' }, { status: 401 })
  }

  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 })
  }

  const parsed = callbackSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed.', details: parsed.error.flatten() }, { status: 422 })
  }

  const { jobId } = await params
  const payload = { ...parsed.data, job_id: parsed.data.job_id || jobId }
  const orderId = readOrderId(payload)
  if (!orderId) {
    return NextResponse.json({ error: 'PrintLab callback is missing source_order_id.' }, { status: 422 })
  }

  // This is a SIGNAL from PrintLab (authenticated by the shared secret above, never by a session cookie). What PrintLab reports is always recorded; it moves the
  // order's status only if the order is RELEASED to production - decided under the lock on the order, on the facts read after it - and only for the statuses
  // PrintLab is known to send. PrintLab is answered with 200 either way: it must not retry, and the order's payment state is not its business.
  try {
    const result = await withReleaseLock(orderId, 'printlab-callback', async ({ tx, order, decision }) => {
      const metadata = mergePrintLabCallbackMetadata(order.metadata, payload)
      const wanted = printLabSignalOrderStatus(payload.status, order.status)
      const status = wanted && decision.released ? wanted : order.status
      await tx.printOrder.update({
        where: { id: order.id },
        data: withFinancialRevision(order, {
          metadata: metadata as Prisma.InputJsonValue,
          ...(status !== order.status ? { status } : {}),
        }),
      })
      if (!decision.released) noteUnreleasedSignal('printlab-callback', order.id, decision, { printLabStatus: String(payload.status), wouldHaveBecome: wanted })
      return { orderId: order.id, status, released: decision.released, releaseState: decision.state }
    }, { require: 'none' })
    return NextResponse.json({ ok: true, orderId: result.orderId, status: result.status, released: result.released, ...(result.released ? {} : { releaseState: result.releaseState }) })
  } catch (error) {
    if (error instanceof ProductionReleaseError && error.status === 404) {
      return NextResponse.json({ error: 'Linked MakerWorks order was not found.' }, { status: 404 })
    }
    throw error
  }
}
