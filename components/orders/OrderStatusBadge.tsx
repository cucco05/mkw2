import { isAwaitingStatus, normalizeOrderStatus, statusLabel } from '@/lib/order-status'

const COLOR_MAP: Record<string, string> = {
  queued: 'border-amber-400/40 text-amber-200 bg-amber-500/10',
  printing: 'border-sky-400/40 text-sky-200 bg-sky-500/10',
  failed: 'border-rose-400/50 text-rose-200 bg-rose-500/10',
  post_process: 'border-emerald-400/50 text-emerald-200 bg-emerald-500/10',
  shipped: 'border-emerald-400/50 text-emerald-200 bg-emerald-500/10',
  completed: 'border-white/20 text-slate-200 bg-white/5',
  cancelled: 'border-rose-400/40 text-rose-200 bg-rose-500/10',
}

export default function OrderStatusBadge({ status }: { status: string }) {
  // An order that waits for a payment or a review is not "queued": it says what it waits for, in a colour of its own.
  const awaiting = isAwaitingStatus(status)
  const normalized = normalizeOrderStatus(status)
  const colorCls = awaiting ? 'border-slate-400/40 text-slate-200 bg-slate-500/10' : (COLOR_MAP[normalized] || 'border-white/20 text-slate-200 bg-white/5')
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] uppercase tracking-wide border ${colorCls}`}>
      {statusLabel(status)}
    </span>
  )
}
