"use client"
// The checkout page for card payment on Stripe's hosted page. The customer sees the SERVER's quote (items, delivery, tax, total) and
// presses one button; the server then creates the order with that frozen total and returns Stripe's page, where the card is entered.
//
//   * nothing here prices anything: the request says what is wanted, the answer says what it costs, and what is paid is that answer
//     (the total shown is sent back as `expectedTotalCents`; if the server's price moved in the meantime it refuses and nothing is made);
//   * the button works once: a lock and a disabled state against a double click, and a key (lib/checkout-client.ts) that makes
//     a repeated request give the same order and the same payment page;
//   * every failure has a sentence and a next step (lib/checkout-copy.ts); none of them says "paid" - that is only ever known
//     from the server, on the page the customer comes back to (step 4.3).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import TrustBadge from '@/components/checkout/TrustBadge'
import QuoteSummary from '@/components/checkout/QuoteSummary'
import { useServerQuote } from '@/components/checkout/useServerQuote'
import { useCart } from '@/components/cart/CartProvider'
import { formatCurrency } from '@/lib/currency'
import { HOSTED_CHECKOUT_COPY as t, MANUAL_QUOTE_COPY_IT, failureMessage } from '@/lib/checkout-copy'
import ManualQuoteForm from '@/components/checkout/ManualQuoteForm'
import { rememberPendingOrder } from '@/lib/order-status-client'
import {
  affectedLines, buildQuoteRequest, forgetCheckoutKey, requestSession, resolveCheckoutKey,
  type CheckoutFailure, type DeliveryMethod,
} from '@/lib/checkout-client'

const RUSH_KEY = 'mwv2:cart:rush' // set by the cart page
const DELIVERY_KEY = 'mw:checkout:delivery'
const REDIRECT_GRACE_MS = 15_000

function sessionStore(): Storage | null {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null } catch { return null }
}

type Props = {
  // the person is signed in (a guest is told no account is needed)
  signedIn: boolean
  // the page was opened by Stripe's "back" link after an interrupted payment
  canceled: boolean
  // administrators and organizations have their own billing page
  showBillingLink: boolean
}

export default function HostedCheckout({ signedIn, canceled, showBillingLink }: Props) {
  const { items, ready, remove } = useCart()
  const [prefs, setPrefs] = useState<{ rush: boolean; delivery: DeliveryMethod } | null>(null)
  const [paying, setPaying] = useState(false)
  const [payFailure, setPayFailure] = useState<CheckoutFailure | null>(null)
  const [showCanceled, setShowCanceled] = useState(canceled)
  const payLock = useRef(false)
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Rush and delivery are read ONCE, together, so the first quote is asked with the right ones (no second, corrected request).
  useEffect(() => {
    let rush = false
    let delivery: DeliveryMethod = 'pickup'
    try { rush = localStorage.getItem(RUSH_KEY) === '1' } catch { /* storage blocked: defaults */ }
    try { delivery = sessionStore()?.getItem(DELIVERY_KEY) === 'ship' ? 'ship' : 'pickup' } catch { /* defaults */ }
    setPrefs({ rush, delivery })
  }, [])

  const request = useMemo(
    () => (ready && prefs && items.length > 0 ? buildQuoteRequest(items, { shippingMethod: prefs.delivery, rush: prefs.rush }) : null),
    [ready, prefs, items],
  )
  const { state, signature, refresh } = useServerQuote(request)

  const quote = state.phase === 'ready' ? state.quote : null
  const shown = quote ?? (state.phase === 'loading' || state.phase === 'error' ? state.stale : null)
  const quoteFailure = state.phase === 'error' ? state.failure : null
  const money = useCallback((cents: number) => formatCurrency(cents / 100, (shown?.currency ?? 'EUR') as any), [shown?.currency])

  const chooseDelivery = useCallback((delivery: DeliveryMethod) => {
    setPayFailure(null)
    setPrefs((current) => (current ? { ...current, delivery } : current))
    try { sessionStore()?.setItem(DELIVERY_KEY, delivery) } catch { /* not remembered, still works */ }
  }, [])

  // The server says shipping is not offered: fall back to pickup instead of leaving the customer stuck.
  useEffect(() => {
    if (prefs?.delivery === 'ship' && (quoteFailure?.kind === 'shipping_unavailable' || quote?.shippingOffer.shipAvailable === false)) {
      chooseDelivery('pickup')
    }
  }, [prefs?.delivery, quoteFailure?.kind, quote?.shippingOffer.shipAvailable, chooseDelivery])

  // Coming back from Stripe with the browser's back button restores this page "as it was": paying again must be possible.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      payLock.current = false
      setPaying(false)
      setShowCanceled(true)
    }
    window.addEventListener('pageshow', onShow)
    return () => {
      window.removeEventListener('pageshow', onShow)
      if (redirectTimer.current) clearTimeout(redirectTimer.current)
    }
  }, [])

  const problemLines = useMemo(() => affectedLines(payFailure ?? quoteFailure, items.length), [payFailure, quoteFailure, items.length])

  const removeUnavailable = useCallback(() => {
    for (const index of problemLines) {
      const item = items[index]
      if (item) remove(item.modelId, item.partId ?? null, item.cartItemId)
    }
    setPayFailure(null)
  }, [problemLines, items, remove])

  const pay = useCallback(async () => {
    if (payLock.current || !quote || !request || !signature || !quote.canCheckout) return
    payLock.current = true // a second click in the same instant finds this and does nothing
    setPaying(true)
    setPayFailure(null)
    setShowCanceled(false)
    const checkoutKey = resolveCheckoutKey(sessionStore(), signature, quote.totalCents)
    const result = await requestSession({ request, expectedTotalCents: quote.totalCents, checkoutKey })
    if (result.ok) {
      // This browser sent THIS order to the payment page: on its way back the cart is emptied for it (and only for it)
      rememberPendingOrder(sessionStore(), result.orderId)
      // Stay locked while the browser leaves for Stripe; if it does not, give the button back with an explanation.
      redirectTimer.current = setTimeout(() => {
        payLock.current = false
        setPaying(false)
        setPayFailure({ kind: 'unknown', code: 'REDIRECT_STALLED', status: 0, retry: true })
      }, REDIRECT_GRACE_MS)
      window.location.assign(result.url)
      return
    }
    payLock.current = false
    setPaying(false)
    setPayFailure(result.failure)
    if (result.failure.kind === 'conflict') forgetCheckoutKey(sessionStore())
    // The price moved or the cart is no longer sellable: show what the server says now.
    if (['price_changed', 'items', 'option', 'minimum', 'payment_minimum', 'review', 'invalid', 'shipping_unavailable', 'conflict'].includes(result.failure.kind)) refresh()
  }, [quote, request, signature, refresh])

  // ---- what to show --------------------------------------------------------------------------------------------------------------
  if (!ready || !prefs) {
    return (
      <Shell>
        <p className="text-sm text-slate-300" role="status">{t.loadingCart}</p>
      </Shell>
    )
  }

  if (items.length === 0) {
    return (
      <Shell>
        {showCanceled ? <Notice tone="info">{t.canceledNotice}</Notice> : null}
        <div className="glass rounded-xl p-6 text-center space-y-3">
          <h2 className="text-lg font-semibold">{t.emptyTitle}</h2>
          <p className="text-sm text-slate-300">{t.emptyMessage}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Link href="/products" className="btn min-h-11">{t.goToShop}</Link>
            <Link href="/discover" className="btn min-h-11">{t.goToDiscover}</Link>
          </div>
        </div>
      </Shell>
    )
  }

  const failure = payFailure ?? quoteFailure
  const askingAgain = state.phase === 'loading'
  const blockedMessage = quote && !quote.canCheckout
    ? failureMessage({ kind: 'disabled', code: quote.unavailableReason ?? '', status: 503, retry: false }, money)
    : null
  const canPay = Boolean(quote && quote.canCheckout && !paying && !failure?.kind.match(/^(items|option|minimum|payment_minimum|invalid|review)$/))
  const payLabel = paying ? t.paying : askingAgain || !quote ? t.updatingQuote : t.payButton(money(quote.totalCents))
  const deliveryAvailable = shown?.shippingOffer.shipAvailable !== false

  return (
    <Shell>
      {showCanceled ? <Notice tone="info">{t.canceledNotice}</Notice> : null}

      <fieldset className="glass rounded-xl p-4 sm:p-5 space-y-3" disabled={paying}>
        <legend className="px-1 text-sm font-semibold">{t.deliveryTitle}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <DeliveryOption
            id="delivery-pickup" testId="delivery-pickup" checked={prefs.delivery === 'pickup'} onSelect={() => chooseDelivery('pickup')}
            label={t.pickup} note={t.pickupNote}
          />
          <DeliveryOption
            id="delivery-ship" testId="delivery-ship" checked={prefs.delivery === 'ship'} onSelect={() => chooseDelivery('ship')}
            disabled={!deliveryAvailable}
            label={t.ship}
            note={deliveryAvailable && shown?.shippingOffer.shipCents != null ? money(shown.shippingOffer.shipCents) : t.shipUnavailable}
          />
        </div>
        {prefs.delivery === 'ship' && deliveryAvailable ? <p className="text-xs text-slate-400">{t.shipAddressNote}</p> : null}
      </fieldset>

      {shown ? (
        <QuoteSummary quote={shown} rush={prefs.rush} problemLines={problemLines} dimmed={askingAgain || state.phase === 'error'} />
      ) : (
        <div className="glass rounded-xl p-5 text-sm text-slate-300" role="status">{askingAgain ? t.loadingQuote : null}</div>
      )}

      {failure ? (
        <Notice tone="error" testId="checkout-error">
          <p>{failure.code === 'REDIRECT_STALLED' ? t.stripeRedirectFailed : failureMessage(failure, money)}</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            {failure.kind === 'items' && problemLines.size > 0 ? <button type="button" className="btn min-h-11" onClick={removeUnavailable}>{t.removeUnavailable}</button> : null}
            {(failure.kind === 'items' || failure.kind === 'option' || failure.kind === 'minimum' || failure.kind === 'payment_minimum' || failure.kind === 'invalid' || failure.kind === 'too_many_attempts')
              ? <Link href="/cart" className="btn min-h-11">{t.changeInCart}</Link> : null}
            {failure.kind === 'not_payable' && failure.orderId
              ? <Link href={`/checkout/success?order=${encodeURIComponent(failure.orderId)}`} className="btn min-h-11">{t.checkOrderStatus}</Link> : null}
            {(failure.retry || failure.kind === 'busy' || failure.kind === 'conflict' || failure.kind === 'unknown' || failure.kind === 'network') && !payFailure
              ? <button type="button" className="btn min-h-11" onClick={refresh}>{t.retry}</button> : null}
          </div>
          {failure.kind === 'review' && request ? <ManualQuoteForm request={request} failure={failure} copy={MANUAL_QUOTE_COPY_IT} signedIn={signedIn} lineTitle={(index) => items[index]?.title ?? null} /> : null}
        </Notice>
      ) : null}
      {blockedMessage && !failure ? <Notice tone="error" testId="checkout-error">{blockedMessage}</Notice> : null}

      <div className="space-y-3">
        <button
          type="button" data-testid="pay-button" onClick={pay} disabled={!canPay}
          aria-disabled={!canPay} aria-busy={paying}
          className="btn w-full min-h-12 text-base disabled:cursor-not-allowed disabled:opacity-60"
        >
          {payLabel}
        </button>
        <p className="text-center text-xs text-slate-400">{t.payHint}</p>
        <TrustBadge title={t.secureTitle} note={t.secureNote} />
        {!signedIn ? <p className="text-xs text-slate-400">{t.guestNote}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Link href="/cart" className="inline-flex min-h-11 items-center underline underline-offset-2">{t.goToCart}</Link>
          {showBillingLink ? <Link href="/checkout/billing" className="inline-flex min-h-11 items-center underline underline-offset-2 text-slate-300">{t.billingLink}</Link> : null}
        </div>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold">{t.pageTitle}</h1>
      {children}
    </div>
  )
}

function Notice({ tone, children, testId }: { tone: 'info' | 'error'; children: React.ReactNode; testId?: string }) {
  const style = tone === 'error' ? 'border-red-400/50 bg-red-500/10 text-red-100' : 'border-sky-400/40 bg-sky-500/10 text-sky-100'
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} data-testid={testId} className={`rounded-lg border px-4 py-3 text-sm ${style}`}>
      {children}
    </div>
  )
}

function DeliveryOption(props: { id: string; testId: string; checked: boolean; disabled?: boolean; onSelect: () => void; label: string; note: string }) {
  return (
    <label
      htmlFor={props.id}
      className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm ${props.checked ? 'border-brand-500 bg-white/10' : 'border-white/15 bg-white/5'} ${props.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <input
        id={props.id} data-testid={props.testId} type="radio" name="delivery" className="h-4 w-4"
        checked={props.checked} disabled={props.disabled} onChange={props.onSelect}
      />
      <span className="flex flex-col">
        <span className="font-medium">{props.label}</span>
        <span className="text-xs text-slate-400">{props.note}</span>
      </span>
    </label>
  )
}
