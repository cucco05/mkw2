// Changing an order's metadata (a JSON column) is read-modify-write: two writers at the same time lose one change.
// Everything that edits it after payment (effect markers, receipts, reports) goes through here: the row is locked for the
// short time between reading and writing.
//
// (step 4.6, S6) Two rules on top of that:
//   * `columns` may only be the receipt / invoice columns this helper was made for. It used to accept ANY column of the order (status, payment status, paid date...), which made
//     it a way to write them without the release decision and without the lock discipline of the payment code; the type and a runtime check now refuse the rest;
//   * whatever the mutation does, the financial revision (lib/financial-revision.ts) goes up in the same UPDATE if a financial fact of the order changes - for instance the
//     link to a Stripe invoice, or a financial key of the metadata - so no caller needs to remember it.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { FINANCIAL_PREV_SELECT, withFinancialRevision } from '@/lib/financial-revision'

export function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export const METADATA_HELPER_COLUMNS = ['receiptUrl', 'receiptStatus', 'stripeCustomerId', 'stripeInvoiceId', 'hostedInvoiceUrl', 'invoicePdfUrl'] as const
export type MetadataHelperColumns = Partial<Pick<Prisma.PrintOrderUncheckedUpdateInput, (typeof METADATA_HELPER_COLUMNS)[number]>>

export async function updateOrderMetadata<T>(
  orderId: string,
  mutate: (metadata: Record<string, unknown>) => { metadata: Record<string, unknown>; columns?: MetadataHelperColumns; result: T },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await tx.printOrder.findUniqueOrThrow({ where: { id: orderId }, select: FINANCIAL_PREV_SELECT })
    const next = mutate(metadataRecord(order.metadata))
    const columns = (next.columns || {}) as Record<string, unknown>
    for (const column of Object.keys(columns)) {
      if (!(METADATA_HELPER_COLUMNS as readonly string[]).includes(column)) throw new Error(`updateOrderMetadata: the column "${column}" is not allowed here (only ${METADATA_HELPER_COLUMNS.join(', ')})`)
    }
    await tx.printOrder.update({
      where: { id: orderId },
      data: withFinancialRevision(order, { ...columns, metadata: next.metadata as Prisma.InputJsonValue }),
    })
    return next.result
  }, { maxWait: 10_000, timeout: 15_000 })
}
