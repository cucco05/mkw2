"use client"
// "This cart was already sent to the payment page" - shown on the cart and the checkout, from the browser's memory AND the server's answer.
//   * the server decides what became of the payment (the same endpoint as the return page, without the "I am back" hint);
//   * confirming / received-and-under-check: the cart stays, a notice says so and the page may switch its "pay" button off (`onInFlightChange`);
//     the server refuses a second payment for the same cart anyway (PAYMENT_IN_PROGRESS), this only spares the customer the refusal;
//   * paid: the confirmation is shown AT ONCE and stays on the page; what happens to the cart, the key and the memory of the order is a separate job, done by the component that stays on the
//     page (usePaidSettlement, lib/checkout-single-flight.ts) - the small component that asks the server only asks and tells (R1-2, S-08). Until that job is final "pay" stays off;
//   * anything else (not paid, expired, not ours): nothing is shown, and an order that can never be seen again is forgotten.
import Link from 'next/link'
import { useCallback, useEffect, useRef } from 'react'
import { usePaidSettlement, paidNote } from '@/components/checkout/usePaidSettlement'
import { useOrderStatus } from '@/components/checkout/useOrderStatus'
import { persistentStore, usePendingOrder } from '@/components/checkout/usePendingOrder'
import { blocksNewPayment } from '@/lib/checkout-single-flight'
import { PENDING_PAYMENT_COPY, formatOrderNumber, type PendingPaymentCopy } from '@/lib/checkout-copy'
import { decideCartAfterStatus, forgetPendingOrder, isUncertainPayment, pendingOrderFor, type PendingOrder } from '@/lib/order-status-client'

type Props = {
  // the cart in front of the customer (lib/checkout-client.ts cartItemsSignature), or null while it is empty or not read yet
  cartSignature: string | null
  // tells the page whether a payment for this cart is being confirmed / waits for a person / is verified and not settled yet
  onInFlightChange?: (inFlight: boolean) => void
  // the server has verified the payment of this cart (the page can stop saying "not completed")
  onPaid?: () => void
  // the page is leaving for the payment page: nothing is asked while it does
  paused?: boolean
  copy?: PendingPaymentCopy
}

const BOX = 'rounded-xl border p-4 space-y-2 text-sm'
const LINK = 'inline-flex min-h-11 items-center justify-center rounded-md border border-white/20 px-4 text-sm hover:border-white/40'

export default function PendingPaymentNotice({ cartSignature, onInFlightChange, onPaid, paused = false, copy = PENDING_PAYMENT_COPY }: Props) {
  const entry = usePendingOrder(cartSignature)
  const { view, paidVerified } = usePaidSettlement()
  const verified = useCallback((info: { orderId: string; orderNumber: number }) => { paidVerified(info); onPaid?.() }, [paidVerified, onPaid])
  const note = paidNote(view, cartSignature)
  const noteText = note === 'emptied' ? copy.cartEmptiedNote : note === 'kept' ? copy.cartKeptNote : note === 'pending' ? copy.cartPendingNote : note === 'unlinked' ? copy.cartUnlinkedNote : null
  return (
    <>
      {entry && !paused ? <Watcher key={entry.orderId} entry={entry} onInFlightChange={onInFlightChange} onPaidVerified={verified} copy={copy} /> : null}
      {view ? (
        <section className={`${BOX} border-emerald-400/50 bg-emerald-500/10`} data-testid="pending-payment-paid" role="status">
          <h2 className="text-base font-semibold">{copy.paidTitle}</h2>
          <p className="text-slate-200">{copy.paidMessage}</p>
          {noteText ? <p className="text-slate-200" data-testid="pending-payment-note" data-note={note}>{noteText}</p> : null}
          <p className="text-xs text-slate-300">{copy.orderLabel(formatOrderNumber(view.orderNumber))}</p>
          <Link href={`/checkout/success?order=${encodeURIComponent(view.orderId)}`} className={LINK}>{copy.checkStatus}</Link>
        </section>
      ) : null}
    </>
  )
}

// Asks the server and tells the page what it said. It decides nothing about the cart, the key or the memory of a payment that is verified: that is the page's settlement. (An order that is
// closed, or that this browser may not see, is still forgotten here - there is nothing left to settle.)
function Watcher({ entry, onInFlightChange, onPaidVerified, copy }: {
  entry: PendingOrder
  onInFlightChange?: (inFlight: boolean) => void
  onPaidVerified: (info: { orderId: string; orderNumber: number }) => void
  copy: PendingPaymentCopy
}) {
  const { state, checkAgain } = useOrderStatus(entry.orderId, fetch, { returned: false, askWhenVisible: true })
  const status = state.phase === 'ready' ? state.status : null
  const answered = status?.state ?? null
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (!answered || !status || handled.current === answered) return
    handled.current = answered
    if (answered === 'paid') { onPaidVerified({ orderId: entry.orderId, orderNumber: status.orderNumber }); return }
    const store = persistentStore()
    const decision = decideCartAfterStatus(answered, pendingOrderFor(store, entry.orderId), null)
    if (decision.forgetEntry) forgetPendingOrder(store, entry.orderId)
  }, [answered, status, entry.orderId, onPaidVerified])

  // an order this browser may not see any more (cookie expired, wrong browser) can never be checked: stop remembering it
  useEffect(() => {
    if (state.phase === 'not_found') forgetPendingOrder(persistentStore(), entry.orderId)
  }, [state.phase, entry.orderId])

  // "pay" is off while the payment is being confirmed, waits for a person, or is VERIFIED and not yet settled: the memory of the order is here until the job is final, and this is here as long as it is
  const inFlight = answered !== null && blocksNewPayment(answered)
  useEffect(() => {
    onInFlightChange?.(inFlight)
    return () => onInFlightChange?.(false)
  }, [inFlight, onInFlightChange])

  if (!status || !isUncertainPayment(status.state)) return null
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
