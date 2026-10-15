// Changing an order's metadata (a JSON column) is read-modify-write: two writers at the same time lose one change.
// Everything that edits it after payment (effect markers, receipts, reports) goes through here: the row is locked for the
// short time between reading and writing.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

export function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function updateOrderMetadata<T>(
  orderId: string,
  mutate: (metadata: Record<string, unknown>) => { metadata: Record<string, unknown>; columns?: Prisma.PrintOrderUncheckedUpdateInput; result: T },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await tx.printOrder.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })
    const next = mutate(metadataRecord(order.metadata))
    await tx.printOrder.update({
      where: { id: orderId },
      data: { ...(next.columns || {}), metadata: next.metadata as Prisma.InputJsonValue },
    })
    return next.result
  }, { maxWait: 10_000, timeout: 15_000 })
}
