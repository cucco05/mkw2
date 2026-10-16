"use client"
// The page the customer lands on after the payment page (step 4.3). It shows what the SERVER says about the order and nothing else: arriving here
// proves nothing (anybody can type this address), so the page asks /api/checkout/status and shows the answer. "Paid" appears only when the server says
// verified payment; the same words (CHECKOUT_STATE_COPY) are used for every way of getting here. What the page shows about the order: its number, the
// total and the state - no names, addresses, e-mails or payment identifiers, because the endpoint does not send them.
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { useCart } from '@/components/cart/CartProvider'
import { formatCurrency } from '@/lib/currency'
import { CHECKOUT_ACTIONS, CHECKOUT_STATE_COPY, STATUS_PAGE_COPY as t, formatOrderNumber, supportLine } from '@/lib/checkout-copy'
import { forgetCheckoutKey } from '@/lib/checkout-client'
import { emptiesCart, forgetPendingOrder, pendingOrderIs } from '@/lib/order-status-client'
import type { PublicCheckoutState } from '@/lib/checkout-status'
import { useOrderStatus } from '@/components/checkout/useOrderStatus'

type Props = {
  // the order id from the address; null when it is missing or malformed (shown like an order that is not ours)
  orderId: string | null
  // the visitor is signed in (a guest is told how long the page can be seen again; nobody is promised an account recovers an order)
  signedIn: boolean
  contactEmail: string | null
}

const TONE: Record<PublicCheckoutState | 'unknown' | 'error', string> = {
  paid: 'border-emerald-400/50 bg-emerald-500/10',
  attention: 'border-amber-400/50 bg-amber-500/10',
  confirming: 'border-sky-400/50 bg-sky-500/10',
  pending: 'border-white/20 bg-white/5',
  canceled: 'border-white/20 bg-white/5',
  unknown: 'border-white/20 bg-white/5',
  error: 'border-red-400/50 bg-red-500/10',
}

function sessionStore(): Storage | null {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null } catch { return null }
}

const LINK = 'inline-flex min-h-11 items-center justify-center rounded-md border border-white/20 px-4 text-sm hover:border-white/40'

function Spinner() {
  return <span aria-hidden="true" className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" />
}

export default function CheckoutStatus({ orderId, signedIn, contactEmail }: Props) {
  const { state, checkAgain } = useOrderStatus(orderId)
  const { clear, ready } = useCart()
  const cartHandled = useRef(false)

  // The cart is emptied once the customer has been through the payment page FOR THIS ORDER (the browser remembers having sent it there). An address
  // opened by hand, an old order, another browser: the cart is left alone.
  const answered = state.phase === 'ready' ? state.status.state : null
  useEffect(() => {
    if (!answered || !orderId || !ready || cartHandled.current) return
    if (!pendingOrderIs(sessionStore(), orderId)) return
    if (emptiesCart(answered)) {
      cartHandled.current = true
      clear()
      forgetCheckoutKey(sessionStore())
      forgetPendingOrder(sessionStore())
    } else if (answered === 'canceled') {
      cartHandled.current = true
      forgetPendingOrder(sessionStore())
    }
  }, [answered, orderId, ready, clear])

  if (state.phase === 'loading') {
    return (
      <section className="glass rounded-xl p-5 flex items-center gap-3 text-sm text-slate-300" role="status" aria-live="polite" data-testid="status-loading">
        <Spinner /> {t.loading}
      </section>
    )
  }

  if (state.phase === 'not_found') {
    const copy = CHECKOUT_STATE_COPY.unknown
    return (
      <section className={`rounded-xl border p-5 space-y-3 ${TONE.unknown}`} data-testid="status-unknown">
        <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="text-sm text-slate-200">{copy.message}</p>
          <p className="text-sm text-slate-300">{supportLine(contactEmail)}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href="/" className={LINK}>{t.goHome}</Link>
          <Link href="/cart" className={LINK}>{CHECKOUT_ACTIONS.backToCart}</Link>
        </div>
      </section>
    )
  }

  if (state.phase === 'error') {
    return (
      <section className={`rounded-xl border p-5 space-y-3 ${TONE.error}`} data-testid="status-error">
        <div role="alert" className="space-y-2">
          <h1 className="text-xl font-semibold">{t.errorTitle}</h1>
          <p className="text-sm text-slate-200">{t.errorMessage}</p>
          {state.retrying ? <p className="text-xs text-slate-300">{t.errorRetrying}</p> : null}
        </div>
        <button type="button" className="btn min-h-11" onClick={checkAgain}>{t.retry}</button>
      </section>
    )
  }

  const { status } = state
  const copy = CHECKOUT_STATE_COPY[status.state]
  const total = formatCurrency(status.totalCents / 100, status.currency as any)
  const confirming = status.state === 'confirming'

  return (
    <section className={`rounded-xl border p-5 space-y-4 ${TONE[status.state]}`} data-testid={`status-${status.state}`} data-state={status.state}>
      {/* announced to screen readers whenever it changes */}
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
        <h1 className="text-xl font-semibold">{copy.title}</h1>
        <p className="text-sm text-slate-200">{copy.message}</p>
        {copy.hint ? <p className="text-xs text-slate-300">{copy.hint}</p> : null}
        {confirming && !state.gaveUp ? (
          <p className="flex items-center gap-2 text-xs text-slate-300">{state.asking ? <><Spinner /> {t.asking}</> : t.waiting}</p>
        ) : null}
        {confirming && state.gaveUp ? <p className="text-sm text-slate-200" data-testid="status-gave-up">{t.gaveUp}</p> : null}
      </div>

      <dl className="grid grid-cols-2 gap-3 border-t border-white/10 pt-3 text-sm">
        <div><dt className="text-xs text-slate-400">{t.orderNumberLabel}</dt><dd className="font-medium tabular-nums" data-testid="status-order-number">{formatOrderNumber(status.orderNumber)}</dd></div>
        <div><dt className="text-xs text-slate-400">{t.totalLabel}</dt><dd className="font-medium tabular-nums" data-testid="status-total">{total}</dd></div>
      </dl>

      {(status.state === 'paid' || status.state === 'attention') && !signedIn ? <p className="text-xs text-slate-300">{t.guestKeep}</p> : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {confirming && state.gaveUp ? <button type="button" className="btn min-h-11" onClick={checkAgain}>{CHECKOUT_ACTIONS.keepWaiting}</button> : null}
        {status.state === 'pending' ? <Link href="/checkout" className="btn min-h-11">{CHECKOUT_ACTIONS.resume}</Link> : null}
        {status.state === 'pending' || status.state === 'canceled' ? <Link href="/cart" className={LINK}>{CHECKOUT_ACTIONS.backToCart}</Link> : null}
        {signedIn && status.state !== 'pending' && status.state !== 'canceled'
          ? <Link href="/customer/orders" className="btn min-h-11">{CHECKOUT_ACTIONS.myOrders}</Link> : null}
        {status.state === 'paid' || status.state === 'attention' || confirming ? <Link href="/discover" className={LINK}>{t.keepShopping}</Link> : null}
      </div>
    </section>
  )
}
