import Link from 'next/link'

// The orders that are NOT in the production queue although they look as if they could be (step 4.6, S4): payment not verified, a payment under review or being
// confirmed, a Stripe page still open, a refund under way or already made, an outside order nobody checked, or a paid order still waiting to be moved. They do not count in the queue, in the hours of
// work ahead or in the delivery time shown to customers. The reason is shown here and nowhere a customer can reach (lib/production.ts, `includeRelease`).
export type NotReleasedItem = {
  id: string
  userId?: string | null
  orderLabel: string
  status: string
  createdAt: string
  customerName?: string | null
  customerEmail?: string | null
  paymentMethod?: string | null
  paymentStatus?: string | null
  totalCents?: number | null
  currency?: string | null
  release: { state: string; code: string | null; label: string; detail: string; reviewReason: string | null; activeUntil: string | null }
  printLabStatus: string | null
  unresolvedEffects: boolean
  productionEvidence: string[]
}

function money(cents?: number | null, currency?: string | null) {
  const amount = Math.max(0, Number.isFinite(Number(cents)) ? Number(cents) : 0) / 100
  const code = (currency || 'USD').toUpperCase()
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount) } catch { return `${code} ${amount.toFixed(2)}` }
}
// UTC on purpose: the same text on the server and in the browser, whatever the time zone of either (a client component is rendered on both)
function when(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`
}
// the colors only help: every state also says what it is in words
function tone(state: string) {
  if (state === 'payment_hold' || state === 'payment_processing' || state === 'payment_active' || state === 'payment_refund_pending') return 'border-amber-400/40 bg-amber-500/10 text-amber-100'
  if (state === 'external_review' || state === 'payment_unproven' || state === 'payment_refunded') return 'border-sky-400/40 bg-sky-500/10 text-sky-100'
  return 'border-white/15 bg-white/5 text-slate-200'
}

export default function NotReleasedList({ items, id = 'not-released' }: { items: NotReleasedItem[]; id?: string }) {
  return (
    <section aria-labelledby={`${id}-title`} data-testid={id} className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold">Not in production</h2>
        <p className="text-xs text-slate-400" data-testid={`${id}-count`}>{items.length} {items.length === 1 ? 'order' : 'orders'}</p>
      </div>
      <p className="text-xs text-slate-400">
        These orders are not in the queue: they are not counted in the work ahead or in the delivery time customers see, and nothing can be assigned, sent to PrintLab or advanced until they are released.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400" data-testid={`${id}-empty`}>Nothing is waiting: every order in the list above is released.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id} data-testid={`${id}-item`} className="min-w-0 space-y-2 rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.orderLabel}</p>
                  <p className="break-words font-medium">{item.customerName || item.customerEmail || 'Customer order'}</p>
                  <p className="break-words text-xs text-slate-400">{money(item.totalCents, item.currency)} · {item.paymentMethod || 'n/a'} · {item.paymentStatus || 'n/a'} · {item.status.replace(/_/g, ' ')} · {when(item.createdAt)}</p>
                </div>
              </div>
              <p className={`inline-block max-w-full break-words rounded-lg border px-2 py-1 text-xs ${tone(item.release.state)}`} data-testid={`${id}-reason`}>{item.release.label}</p>
              <p className="break-words text-xs text-slate-300">{item.release.detail}</p>
              {item.release.activeUntil ? <p className="text-xs text-slate-400">A payment page may still be open until {when(item.release.activeUntil)}.</p> : null}
              {item.printLabStatus ? (
                <p className="break-words text-xs text-amber-200">PrintLab reported &quot;{item.printLabStatus}&quot; for this order. It was recorded; the order was not moved.</p>
              ) : null}
              {item.unresolvedEffects ? (
                <p className="break-words text-xs text-rose-200">A call to PrintLab or StockWorks for this order has an outcome nobody knows. Open the order to check it - nothing is sent again by itself.</p>
              ) : null}
              {item.productionEvidence.length > 0 ? (
                <p className="break-words text-xs text-slate-400">Already went to production ({item.productionEvidence.join(', ').replace(/_/g, ' ')}). Stopping a job is a decision for a person in PrintLab.</p>
              ) : null}
              <Link
                href={`/admin/users/${item.userId || 'guest'}/orders/${item.id}`}
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-white/15 px-4 py-2 text-sm hover:border-white/40"
              >
                Open order
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
