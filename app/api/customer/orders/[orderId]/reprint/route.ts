import { NextRequest, NextResponse } from 'next/server'
import { viewerGuards } from '@/lib/viewer'
import { isSameOriginRequest } from '@/lib/csrf'
import { createReprintOrder } from '@/lib/orders'
import { ReprintNotAllowedError } from '@/lib/reprint'
import { consumeFixedWindow } from '@/lib/rate-limit'
import { sendAdminPushNotification } from '@/lib/push'

type CustomerReprintContext = { params: Promise<{ orderId: string }> }

// At most this many reprint requests per customer in the window (one open request per original order is enforced separately).
const REPRINT_RATE = { windowMs: 60 * 60 * 1000, max: 10 }

// "Request a reprint" creates a REQUEST for a new quote (lib/reprint.ts): never an order that can be produced by itself.
export async function POST(req: NextRequest, { params }: CustomerReprintContext) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid request origin.', code: 'INVALID_ORIGIN' }, { status: 403 })
  const { orderId } = await params
  const userId = (await viewerGuards.getViewer())?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const limit = await consumeFixedWindow(`reprint:user:${userId}`, REPRINT_RATE)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds ?? 60) } },
    )
  }
  try {
    const { order, created } = await createReprintOrder(orderId, userId)
    if (created) {
      // best effort: the request is already saved, a failed notification must not undo it
      sendAdminPushNotification({
        title: 'Reprint requested',
        body: `Order ${order.orderNumber ?? order.id}: a customer asked for a reprint quote.`,
        tag: `reprint:${order.id}`,
        data: { orderId: order.id },
      }).catch(() => {})
    }
    return NextResponse.json({ order: { id: order.id, orderNumber: order.orderNumber, status: order.status }, created })
  } catch (err: any) {
    if (err instanceof ReprintNotAllowedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'ORDER_NOT_FOUND' ? 404 : 409 })
    }
    console.error('Reprint request failed:', err)
    return NextResponse.json({ error: 'Unable to request reprint' }, { status: 500 })
  }
}
