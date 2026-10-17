export const ORDER_STATUS_FLOW = [
  { key: 'queued', label: 'Queued' },
  { key: 'printing', label: 'Printing' },
  { key: 'failed', label: 'Failed' },
  { key: 'post_process', label: 'Post-process' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
] as const

export type OrderStatusFlow = (typeof ORDER_STATUS_FLOW)[number]['key']
export type FulfillmentStatusKey = 'pending' | 'ready' | 'picked_up' | 'shipped'

export const LEGACY_ORDER_STATUSES = [
  { key: 'awaiting_review', label: 'Queued (legacy)' },
  { key: 'awaiting_payment', label: 'Payment pending (legacy)' },
  { key: 'in_production', label: 'Printing (legacy)' },
  { key: 'ready', label: 'Post-process (legacy)' },
] as const

export const ORDER_STATUSES = [
  ...ORDER_STATUS_FLOW,
  ...LEGACY_ORDER_STATUSES,
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]['key']

export function normalizeOrderStatus(status: string): OrderStatusFlow {
  if (status === 'awaiting_review' || status === 'awaiting_payment') return 'queued'
  if (status === 'in_production') return 'printing'
  if (status === 'ready') return 'post_process'
  if (status === 'printing' || status === 'post_process' || status === 'queued' || status === 'shipped' || status === 'completed' || status === 'cancelled' || status === 'failed') {
    return status
  }
  return 'queued'
}

// What to SAY about a status. `normalizeOrderStatus` folds the "awaiting" statuses into "queued" for the flow, which hides that the order is still waiting for a
// payment or a review and is NOT in the production queue (step 4.6, S4); the screens that name a status use this one.
export function isAwaitingStatus(status: string) {
  return status === 'awaiting_payment' || status === 'awaiting_review'
}
export function statusLabel(status: string): string {
  if (status === 'awaiting_payment') return 'Awaiting payment'
  if (status === 'awaiting_review') return 'Awaiting review'
  const normalized = normalizeOrderStatus(status)
  return ORDER_STATUS_FLOW.find((entry) => entry.key === normalized)?.label ?? status
}

export function mapFulfillmentToOrderStatus(status?: FulfillmentStatusKey | null): OrderStatusFlow {
  if (status === 'shipped') return 'shipped'
  if (status === 'picked_up') return 'completed'
  if (status === 'ready') return 'post_process'
  return 'queued'
}

export function mapOrderStatusToFulfillment(status: string): FulfillmentStatusKey {
  const normalized = normalizeOrderStatus(status)
  if (normalized === 'shipped') return 'shipped'
  if (normalized === 'completed') return 'picked_up'
  if (normalized === 'post_process') return 'ready'
  return 'pending'
}
