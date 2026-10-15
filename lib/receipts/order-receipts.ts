import { prisma } from '@/lib/db'
import { publicFilePath, saveBuffer } from '@/lib/storage'
import { buildOrderReceiptModel } from './order-receipt-model'
import { renderOrderReceiptPdf } from './pdf-renderer'
import { updateOrderMetadata } from '@/lib/order-metadata'

export function receiptStoragePath(orderId: string, orderNumber: string) {
  const safeNumber = orderNumber.replace(/[^a-z0-9_-]+/gi, '-')
  return `orders/${orderId}/receipts/${safeNumber}-receipt.pdf`
}

export async function findOrderForReceipt(orderId: string) {
  return prisma.printOrder.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      organization: { select: { name: true, category: true, charitableRegistrationNumber: true } },
    },
  })
}

export async function generateAndStoreOrderReceipt(orderId: string, opts: { generatedAt?: Date } = {}) {
  const order = await findOrderForReceipt(orderId)
  if (!order) throw new Error('Order not found')

  const model = buildOrderReceiptModel({ order, generatedAt: opts.generatedAt })
  const pdf = renderOrderReceiptPdf(model)
  const relPath = receiptStoragePath(order.id, model.orderNumber)
  await saveBuffer(relPath, pdf)
  const receiptUrl = publicFilePath(relPath)
  // The metadata is edited under a row lock so that a payment update running at the same moment is not overwritten.
  await updateOrderMetadata(order.id, (metadata) => ({
    metadata: {
      ...metadata,
      receipt: {
        kind: model.kind,
        title: model.title,
        generatedAt: model.generatedAt,
        path: relPath,
        url: receiptUrl,
      },
    },
    columns: { receiptUrl, receiptStatus: 'received' },
    result: undefined,
  }))

  return { model, pdf, relPath, receiptUrl }
}

export async function generateOrderReceiptBestEffort(orderId: string, source: string) {
  try {
    return await generateAndStoreOrderReceipt(orderId)
  } catch (err) {
    console.error(`Receipt generation failed (${source}):`, err)
    return null
  }
}
