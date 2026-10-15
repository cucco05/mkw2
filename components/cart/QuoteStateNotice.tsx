"use client"
// Why the cart has no usable price right now, in the cart's own language (English until the translation phase), with a way forward.
import { CART_COPY, MANUAL_QUOTE_COPY_EN, cartFailureMessage } from '@/lib/checkout-copy'
import type { CheckoutFailure, QuoteRequest } from '@/lib/checkout-client'
import ManualQuoteForm from '@/components/checkout/ManualQuoteForm'

type Props = {
  failure: CheckoutFailure
  money: (cents: number) => string
  onRetry: () => void
  // the cart that was priced, and the names of its lines: needed to ask for a manual quote when some line cannot be paid online
  request?: QuoteRequest | null
  lineTitle?: (index: number) => string | null
}

export default function QuoteStateNotice({ failure, money, onRetry, request, lineTitle }: Props) {
  const canRetry = failure.retry || failure.kind === 'busy' || failure.kind === 'network' || failure.kind === 'unknown'
  return (
    <div role="alert" data-testid="cart-quote-error" className="mt-3 rounded-lg border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm text-red-100">
      <p>{cartFailureMessage(failure, money)}</p>
      {canRetry ? (
        <button type="button" className="mt-2 inline-flex min-h-11 items-center rounded-md border border-white/20 px-4 text-sm" onClick={onRetry}>
          {CART_COPY.retry}
        </button>
      ) : null}
      {failure.kind === 'review' && request ? <ManualQuoteForm request={request} failure={failure} copy={MANUAL_QUOTE_COPY_EN} lineTitle={lineTitle} /> : null}
    </div>
  )
}
