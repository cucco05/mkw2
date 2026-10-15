"use client"
// The order as the server priced it: lines, delivery, tax and the total. Whole cents come from the server; this only formats them.
import { formatCurrency } from '@/lib/currency'
import { HOSTED_CHECKOUT_COPY as t } from '@/lib/checkout-copy'
import type { ServerQuote } from '@/lib/checkout-client'

const HEX = /^#[0-9a-f]{3,8}$/i

type Props = {
  quote: ServerQuote
  rush: boolean
  // lines (by position) the server refused: shown with a border and a note
  problemLines?: Set<number>
  // true while a newer quote is being asked for: the figures are kept but dimmed
  dimmed?: boolean
}

export default function QuoteSummary({ quote, rush, problemLines, dimmed }: Props) {
  const money = (cents: number) => formatCurrency(cents / 100, quote.currency as any)
  const undiscounted = quote.items.reduce((sum, line) => sum + line.undiscountedLineTotalCents, 0)
  const discountCents = Math.max(0, undiscounted - quote.itemsTotalCents)
  const leadHours = quote.items.reduce((sum, line) => sum + (line.leadTimeHours ?? 0), 0)
  const taxRow = quote.tax.mode === 'none' || quote.tax.cents <= 0 ? null : quote.tax

  return (
    <section aria-labelledby="checkout-summary-title" className={`glass rounded-xl p-4 sm:p-5 space-y-4 transition-opacity ${dimmed ? 'opacity-60' : ''}`}>
      <h2 id="checkout-summary-title" className="text-lg font-semibold">{t.summaryTitle}</h2>

      <ul className="divide-y divide-white/10">
        {quote.items.map((line, index) => {
          const problem = problemLines?.has(index)
          return (
            <li key={index} className={`py-3 first:pt-0 last:pb-0 ${problem ? 'rounded-md border border-red-400/60 bg-red-500/5 px-3' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium break-words">{line.title}</div>
                  {line.partName ? <div className="text-xs text-slate-400 break-words">{line.partName}</div> : null}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300">
                    <span>{line.material}</span>
                    {line.finish && line.finish !== 'standard' ? <span>· {line.finish}</span> : null}
                    {line.colors.length > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        {line.colors.map((color, i) => (
                          HEX.test(color)
                            ? <span key={i} className="inline-block h-3 w-3 rounded-full border border-white/30" style={{ backgroundColor: color }} title={color} aria-label={`Colore ${color}`} />
                            : <span key={i}>{color}</span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    {t.lineQty(line.qty, money(line.unitPriceCents))}
                    {line.discountPercent > 0 ? ` · −${line.discountPercent}%` : ''}
                  </div>
                  {problem ? <div className="mt-1 text-xs font-medium text-red-300">{t.lineProblem}</div> : null}
                </div>
                <div className="shrink-0 font-medium tabular-nums">{money(line.lineTotalCents)}</div>
              </div>
            </li>
          )
        })}
      </ul>

      <dl className="space-y-1.5 border-t border-white/10 pt-3 text-sm" aria-live="polite">
        <div className="flex justify-between gap-3"><dt>{t.subtotal}</dt><dd className="tabular-nums">{money(quote.itemsTotalCents)}</dd></div>
        {discountCents > 0 ? (
          <div className="flex justify-between gap-3 text-emerald-300"><dt>{t.discount}</dt><dd className="tabular-nums">−{money(discountCents)}</dd></div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt>{quote.shipping.method === 'ship' ? t.shipping : t.pickupFree}</dt>
          <dd className="tabular-nums">{quote.shipping.method === 'ship' ? money(quote.shipping.cents) : money(0)}</dd>
        </div>
        {taxRow && taxRow.addedToTotal ? (
          <div className="flex justify-between gap-3"><dt>{t.taxLabel(taxRow.ratePercent)}</dt><dd className="tabular-nums">{money(taxRow.cents)}</dd></div>
        ) : null}
        <div className="flex justify-between gap-3 border-t border-white/10 pt-2 text-base font-semibold">
          <dt>{t.total}</dt><dd className="tabular-nums" data-testid="checkout-total">{money(quote.totalCents)}</dd>
        </div>
        {taxRow && !taxRow.addedToTotal ? (
          <div className="text-right text-xs text-slate-400">{t.taxIncluded(taxRow.ratePercent, money(taxRow.cents))}</div>
        ) : null}
      </dl>

      {(rush || leadHours > 0) ? (
        <div className="space-y-1 text-xs text-slate-300">
          {rush ? <div><span className="font-medium">{t.rush}</span> · {t.rushNote}</div> : null}
          {leadHours > 0 ? <div>{t.leadTimeLabel}: {t.leadTime(leadHours)} <span className="text-slate-400">({t.leadTimeNote})</span></div> : null}
        </div>
      ) : null}
    </section>
  )
}
