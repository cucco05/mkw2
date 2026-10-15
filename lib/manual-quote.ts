// A request for a MANUAL QUOTE: what a customer can do when the cart cannot be paid online because no machine can make a line automatically
// (material or finish not offered, a model larger than the printer, a size that cannot be trusted: lib/printability.ts).
//
// It is NOT an order that can go to production. Like a reprint request it starts in `awaiting_review`, payment method/status `quote` (never a
// verified payment, so S5 keeps it out of production), with a total of 0 that means "not priced yet" (metadata.manualQuote.priceStatus), and it
// carries nothing the browser said about prices. A person looks at it, may propose a change (another material, a smaller size, splitting the model
// in parts - always with the customer's consent) and prices it through the usual administrator tools.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { checkoutItemSchema, type CheckoutItemPayload, type CheckoutQuoteErrorDetails } from '@/lib/checkout-quote'
import { getCurrency } from '@/lib/currency'
import { stableStringify } from '@/lib/checkout-client'

export const manualQuoteRequestSchema = z.object({
  items: z.array(checkoutItemSchema).min(1).max(50),
  shipping: z.object({ method: z.enum(['pickup', 'ship']) }).strict().default({ method: 'pickup' }),
  rush: z.boolean().optional().default(false),
  // Required for a guest (how we answer); a signed-in customer may leave it out (the account's email is used).
  contact: z.object({
    email: z.string().trim().toLowerCase().email().max(200),
    name: z.string().trim().max(120).optional(),
  }).strict().optional(),
  note: z.string().trim().max(1000).optional(),
}).strict()

export type ManualQuoteRequest = z.infer<typeof manualQuoteRequestSchema>

export class ManualQuoteError extends Error {
  constructor(readonly status: number, readonly code: 'EMAIL_REQUIRED' | 'NOT_REQUIRED', message: string) {
    super(message)
    this.name = 'ManualQuoteError'
  }
}

type Principal = { id: string; email: string | null; name: string | null } | null

// One request per person and cart and day: pressing the button twice must not create two requests.
export function manualQuoteKey(principalId: string | null, email: string, items: CheckoutItemPayload[], day = new Date()): string {
  const digest = createHash('sha256').update(stableStringify({ principalId, email, items })).digest('hex').slice(0, 40)
  return `manual-${day.toISOString().slice(0, 10).replace(/-/g, '')}-${digest}`
}

export function isManualQuoteAwaitingQuote(order: { metadata?: unknown; paymentStatus?: string | null }): boolean {
  const meta = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? order.metadata as Record<string, unknown> : {}
  const manual = meta.manualQuote && typeof meta.manualQuote === 'object' ? meta.manualQuote as Record<string, unknown> : {}
  return manual.priceStatus === 'to_be_quoted' && order.paymentStatus === 'quote'
}

export async function createManualQuoteOrder(input: {
  principal: Principal
  request: ManualQuoteRequest
  reviews: NonNullable<CheckoutQuoteErrorDetails['reviews']>
}): Promise<{ orderNumber: number; created: boolean }> {
  const { principal, request, reviews } = input
  const email = request.contact?.email ?? principal?.email ?? null
  if (!email) throw new ManualQuoteError(400, 'EMAIL_REQUIRED', 'An email address is needed to answer the request.')
  const name = request.contact?.name?.trim() || principal?.name || null
  const key = manualQuoteKey(principal?.id ?? null, email, request.items)

  const existing = await prisma.printOrder.findUnique({ where: { checkoutKey: key }, select: { orderNumber: true, status: true } })
  if (existing && existing.status !== 'cancelled') return { orderNumber: existing.orderNumber, created: false }

  const modelIds = Array.from(new Set(request.items.map((item) => item.modelId)))
  const partIds = Array.from(new Set(request.items.map((item) => item.partId).filter((id): id is string => Boolean(id))))
  const [models, parts] = await Promise.all([
    prisma.model.findMany({ where: { id: { in: modelIds } }, select: { id: true, title: true } }),
    partIds.length ? prisma.modelPart.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  const titleOf = new Map(models.map((model) => [model.id, model.title]))
  const partNameOf = new Map(parts.map((part) => [part.id, part.name]))
  const requestedAt = new Date().toISOString()

  const order = await prisma.printOrder.create({
    data: {
      userId: principal?.id ?? undefined,
      customerEmail: email,
      customerName: name ?? undefined,
      paymentMethod: 'quote',
      paymentStatus: 'quote',
      shippingMethod: request.shipping.method,
      status: 'awaiting_review',
      subtotalCents: 0,
      totalCents: 0,
      shippingCents: 0,
      taxCents: 0,
      currency: getCurrency(),
      checkoutKey: existing ? `${key}-${Date.now().toString(36)}` : key,
      notes: request.note ? request.note.slice(0, 1000) : undefined,
      metadata: {
        manualQuote: {
          kind: 'customer_request',
          priceStatus: 'to_be_quoted',
          requestedAt,
          rush: request.rush,
          note: request.note ?? null,
          // WHY the cart could not be paid online (decided by the server, never by the browser)
          reasons: reviews,
        },
      } as unknown as Prisma.InputJsonValue,
      items: {
        create: request.items.map((item) => ({
          modelId: item.modelId,
          modelTitle: titleOf.get(item.modelId) ?? 'Model',
          partId: item.partId ?? undefined,
          partName: item.partId ? partNameOf.get(item.partId) ?? undefined : undefined,
          material: String(item.material ?? '').trim().slice(0, 40) || 'PLA',
          colors: item.colors && item.colors.length ? item.colors : undefined,
          infillPct: item.infillPct ?? undefined,
          finish: item.finish ? String(item.finish).slice(0, 40) : undefined,
          quantity: item.qty,
          unitPriceCents: 0,
          totalCents: 0,
          // what the customer asked for (never a price): scale and per-axis scales, as validated by the schema
          configuration: {
            scale: item.scale,
            scaleX: item.scaleX ?? null,
            scaleY: item.scaleY ?? null,
            scaleZ: item.scaleZ ?? null,
            toleranceClass: item.toleranceClass ?? null,
            customText: item.customText ?? null,
            productTemplateId: item.productTemplateId ?? null,
          } as Prisma.InputJsonValue,
        })),
      },
    },
    select: { orderNumber: true },
  })
  return { orderNumber: order.orderNumber, created: true }
}
