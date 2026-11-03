"use client"
// What a page does once the SERVER has said a payment is verified (R1-2, S-08): it SHOWS that at once, and then - separately, and only as far as it is safe - settles the cart, the key and
// the memory of the order (lib/checkout-single-flight.ts, settlePaidPurchase).
//   * the confirmation never waits for the settlement: `view` exists from the moment the payment is verified, and its `outcome` is null until the settlement has an answer;
//   * the settlement belongs to the component that STAYS on the page - the one that calls this hook - and not to the small component that asks the server (which is taken off the page as soon
//     as the memory of the order goes): it keeps its lifetime, so a settlement that is still waiting when the customer leaves the page finds out and does nothing on a page that is gone;
//   * once per order and per visit: asking again for the same order does not start a second settlement. The next visit (a reload, the cart, the checkout, the order page) starts a new one -
//     that is how a settlement that could not be finished is finished, with no new payment and no polling: the memory of the order is still there until the job is final;
//   * with no memory of the order - this browser never sent it to the payment page - nothing is done (the page shows what the server says, as it always did).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCart } from '@/components/cart/CartProvider'
import { persistentStore } from '@/components/checkout/usePendingOrder'
import { settlePaidPurchase, type PaidSettlement } from '@/lib/checkout-single-flight'
import { pendingOrderFor } from '@/lib/order-status-client'

export type PaidView = {
  orderId: string
  orderNumber: number
  // the cart the page sent to the payment page, as the memory of the order held it (the notes compare it with the cart now in front of the customer)
  recordCartSignature: string
  // null while the settlement is still going on
  outcome: PaidSettlement | null
}

export function usePaidSettlement() {
  const { clearIf } = useCart()
  const [view, setView] = useState<PaidView | null>(null)
  // one per mount of the page: `alive` goes false and the signal aborts when the page is left (the effect runs twice in development, so it makes a new one each time)
  const life = useRef<{ alive: boolean; controller: AbortController } | null>(null)
  const started = useRef<Set<string>>(new Set())

  useEffect(() => {
    const mine = { alive: true, controller: new AbortController() }
    life.current = mine
    return () => { mine.alive = false; mine.controller.abort() }
  }, [])

  const paidVerified = useCallback((info: { orderId: string; orderNumber: number }) => {
    const mine = life.current
    if (!mine || !mine.alive || started.current.has(info.orderId)) return
    const store = persistentStore()
    const record = pendingOrderFor(store, info.orderId)
    if (!record) return
    started.current.add(info.orderId)
    setView({ orderId: info.orderId, orderNumber: info.orderNumber, recordCartSignature: record.cartSignature, outcome: null })
    void settlePaidPurchase({
      store, orderId: info.orderId, recordCartSignature: record.cartSignature, clearIf,
      lifetime: { alive: () => mine.alive, signal: mine.controller.signal },
    }).then((outcome) => {
      // a page that is gone gets no update; the memory of the order was dealt with (or kept) by the settlement itself
      if (mine.alive) setView((current) => (current && current.orderId === info.orderId ? { ...current, outcome } : current))
    })
  }, [clearIf])

  return { view, paidVerified }
}

// The note under the confirmation, if there is one to give. Four different things can be true and the customer must be able to tell them apart (lib/checkout-copy.ts):
//   emptied   the cart was emptied;
//   kept      the cart was NOT emptied because it may hold a NEW purchase (the key in the slot is another purchase's);
//   pending   the job is not finished and the next visit to the cart finishes it;
//   unlinked  this cart can not be tied to that payment with certainty: it was left as it is.
// `pending` and `unlinked` are about the cart that was paid: they are not shown for a cart the customer has since changed. `kept` is shown only while the cart still holds what the order held.
export type PaidNote = 'emptied' | 'kept' | 'pending' | 'unlinked'
export function paidNote(view: PaidView | null, currentCartSignature: string | null): PaidNote | null {
  const outcome = view?.outcome
  if (!view || !outcome) return null
  const sameCart = currentCartSignature !== null && currentCartSignature === view.recordCartSignature
  switch (outcome.kind) {
    case 'applied': return 'emptied'
    case 'not_owned': return sameCart ? 'kept' : null
    case 'provenance_unknown': return sameCart ? 'unlinked' : null
    case 'deferred': return sameCart ? 'pending' : null
    default: return null // cart_changed, already_settled: there is nothing to add
  }
}
