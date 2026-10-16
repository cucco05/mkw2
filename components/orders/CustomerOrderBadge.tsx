import OrderStatusBadge from '@/components/orders/OrderStatusBadge'
import { CUSTOMER_ORDER_COPY, describeCustomerOrder, type CustomerOrderLike } from '@/lib/customer-order-labels'

// The badge of the customer area: payment-aware (an unpaid order is not "Queued"), the usual production badge for everything else.
export default function CustomerOrderBadge({ order }: { order: CustomerOrderLike }) {
  const kind = describeCustomerOrder(order)
  if (kind === 'production') return <OrderStatusBadge status={order.status} />
  const copy = CUSTOMER_ORDER_COPY[kind]
  return (
    <span data-testid="order-badge" data-kind={kind} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] uppercase tracking-wide border ${copy.tone}`}>
      {copy.label}
    </span>
  )
}
