"use client"
// "This cart was already sent to the payment page" - shown on the cart and the checkout, from the browser's memory AND the server's answer.
//   * the server decides what became of the payment (the same endpoint as the return page, without the "I am back" hint);
//   * confirming / received-and-under-check: the cart stays, a notice says so and the page may switch its "pay" button off (`onInFlightChange`);
//     the server refuses a second payment for the same cart anyway (PAYMENT_IN_PROGRESS), this only spares the customer the refusal;
//   * paid: the cart is emptied (if it is still the cart that was paid) and a confirmation stays on the page;
//   * anything else (not paid, expired, not ours): nothing is shown, and an order that can never be seen again is forgotten.
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCart } from '@/components/cart/CartProvider'
import { useOrderStatus } from '@/components/checkout/useOrderStatus'
import { persistentStore, usePendingOrder } from '@/components/checkout/usePendingOrder'
import { forgetCheckoutKey } from '@/lib/checkout-client'
import { PENDING_PAYMENT_COPY, formatOrderNumber, type PendingPaymentCopy } from '@/lib/checkout-copy'
import { decideCartAfterStatus, forgetPendingOrder, isUncertainPayment, pendingOrderFor, type PendingOrder } from '@/lib/order-status-client'

type Props = {
  // the cart in front of the customer (lib/checkout-client.ts cartItemsSignature), or null while it is empty or not read yet
  cartSignature: string | null
  // tells the page whether a payment for this cart is being confirmed / waits for a person
  onInFlightChange?: (inFlight: boolean) => void
  // the server has verified the payment of this cart (the page can stop saying "not completed")
  onPaid?: () => void
  // the page is leaving for the payment page: nothing is asked while it does
  paused?: boolean
  copy?: PendingPaymentCopy
}

type Settled = { orderNumber: number; orderId: string }

const BOX = 'rounded-xl border p-4 space-y-2 text-sm'
const LINK = 'inline-flex min-h-11 items-center justify-center rounded-md border border-white/20 px-4 text-sm hover:border-white/40'

export default function PendingPaymentNotice({ cartSignature, onInFlightChange, onPaid, paused = false, copy = PENDING_PAYMENT_COPY }: Props) {
  const entry = usePendingOrder(cartSignature)
  const [settled, setSettled] = useState<Settled | null>(null)
  const paid = useCallback((value: Settled) => { setSettled(value); onPaid?.() }, [onPaid])
  return (
    <>
      {entry && !paused ? <Watcher key={entry.orderId} entry={entry} cartSignature={cartSignature} onInFlightChange={onInFlightChange} onPaid={paid} copy={copy} /> : null}
      {!(entry && !paused) && settled ? (
        <section className={`${BOX} border-emerald-400/50 bg-emerald-500/10`} data-testid="pending-payment-paid" role="status">
          <h2 className="text-base font-semibold">{copy.paidTitle}</h2>
          <p className="text-slate-200">{copy.paidMessage}</p>
          <p className="text-xs text-slate-300">{copy.orderLabel(formatOrderNumber(settled.orderNumber))}</p>
          <Link href={`/checkout/success?order=${encodeURIComponent(settled.orderId)}`} className={LINK}>{copy.checkStatus}</Link>
        </section>
      ) : null}
    </>
  )
}

function Watcher({ entry, cartSignature, onInFlightChange, onPaid, copy }: {
  entry: PendingOrder
  cartSignature: string | null
  onInFlightChange?: (inFlight: boolean) => void
  onPaid: (settled: Settled) => void
  copy: PendingPaymentCopy
}) {
  const { clear } = useCart()
  const { state, checkAgain } = useOrderStatus(entry.orderId, fetch, { returned: false, askWhenVisible: true })
  const status = state.phase === 'ready' ? state.status : null
  const answered = status?.state ?? null
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (!answered || !status || handled.current === answered) return
    handled.current = answered
    const store = persistentStore()
    const decision = decideCartAfterStatus(answered, pendingOrderFor(store, entry.orderId), cartSignature)
    if (decision.emptyCart) {
      clear()
      forgetCheckoutKey(store)
    }
    if (answered === 'paid') onPaid({ orderNumber: status.orderNumber, orderId: entry.orderId })
    if (decision.forgetEntry) forgetPendingOrder(store, entry.orderId)
  }, [answered, status, entry.orderId, cartSignature, clear, onPaid])

  // an order this browser may not see any more (cookie expired, wrong browser) can never be checked: stop remembering it
  useEffect(() => {
    if (state.phase === 'not_found') forgetPendingOrder(persistentStore(), entry.orderId)
  }, [state.phase, entry.orderId])

  const inFlight = answered !== null && isUncertainPayment(answered)
  useEffect(() => {
    onInFlightChange?.(inFlight)
    return () => onInFlightChange?.(false)
  }, [inFlight, onInFlightChange])

  if (!status || !inFlight) return null
  const attention = status.state === 'attention'
  return (
    <section className={`${BOX} ${attention ? 'border-amber-400/50 bg-amber-500/10' : 'border-sky-400/50 bg-sky-500/10'}`} data-testid={`pending-payment-${status.state}`} role="status" aria-live="polite">
      <h2 className="text-base font-semibold">{attention ? copy.attentionTitle : copy.confirmingTitle}</h2>
      <p className="text-slate-200">{attention ? copy.attentionMessage : copy.confirmingMessage}</p>
      <p className="text-xs text-slate-300">{copy.orderLabel(formatOrderNumber(status.orderNumber))}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href={`/checkout/success?order=${encodeURIComponent(entry.orderId)}`} className="btn min-h-11">{copy.checkStatus}</Link>
        <button type="button" className={LINK} onClick={checkAgain}>{copy.recheck}</button>
      </div>
    </section>
  )
}
