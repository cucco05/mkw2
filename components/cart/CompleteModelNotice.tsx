"use client"
// "The parts in your cart would make a complete model" (step 4.6): the server suggests, the customer chooses - group them as one complete model, or confirm that
// they want the parts one by one at the total shown. Shared by the cart page (English) and the checkout page (Italian). Prices come from the server's quote.
import { useCart, type CartItem } from '@/components/cart/CartProvider'
import type { CompleteModelCopy } from '@/lib/checkout-copy'
import type { CompleteModelNotice as Notice } from '@/lib/single-parts-ack'

type Props = {
  // the lines the quote was asked for, in the order of the request (the notices point at positions in it)
  items: CartItem[]
  notices: Notice[]
  // true until this exact cart and total are confirmed as single parts
  mustChoose: boolean
  onConfirm: () => void
  // what the items cost as single parts (the subtotal of the quote)
  totalCents: number
  money: (cents: number) => string
  copy: CompleteModelCopy
}

export default function CompleteModelNotice({ items, notices, mustChoose, onConfirm, totalCents, money, copy }: Props) {
  const { canGroupAsSet, groupAsSet } = useCart()
  if (notices.length === 0) return null
  return (
    <div className="space-y-3" data-testid="complete-model-notices">
      {notices.map((notice, index) => {
        const lines = notice.itemIndexes.map((position) => items[position]).filter((line): line is CartItem => Boolean(line))
        if (lines.length === 0) return null
        const ids = lines.map((line) => line.cartItemId)
        const check = canGroupAsSet(ids)
        return (
          <div key={`${lines[0].modelId}-${index}`} role="status" data-testid="complete-model-notice"
            className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-50">
            <p className="font-medium break-words">{copy.title(lines[0].title)}</p>
            <p className="mt-1 break-words">{copy.body(money(totalCents))}</p>
            {mustChoose ? <p className="mt-1 font-medium">{copy.mustChoose}</p> : <p className="mt-1 text-amber-100/80">{copy.chosen}</p>}
            {!check.ok ? <p className="mt-1 text-xs text-amber-100/80" data-testid="complete-model-cannot-group">{copy.cannotGroup[check.reason]}</p> : null}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              {check.ok ? (
                <button type="button" data-testid="group-as-set" className="btn min-h-11" onClick={() => groupAsSet(ids)}>{copy.group}</button>
              ) : null}
              {mustChoose ? (
                <button type="button" data-testid="confirm-single-parts" className="btn min-h-11" onClick={onConfirm}>{copy.confirm(money(totalCents))}</button>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
