"use client"
// "Some lines cannot be paid online": WHY (the server's reasons, line by line) and a request for a manual quote. Used by the cart (English) and by
// the checkout (Italian): the language comes in as `copy`. Nothing here prices or decides anything; the server re-checks the cart when the request
// arrives (/api/checkout/manual-request) and refuses it when the cart can be paid online. No order is paid, nothing is charged.
import { useId, useRef, useState } from 'react'
import { formatOrderNumber, type ManualQuoteCopy } from '@/lib/checkout-copy'
import { requestManualQuote, type CheckoutFailure, type QuoteRequest } from '@/lib/checkout-client'

type Props = {
  request: QuoteRequest
  failure: CheckoutFailure
  copy: ManualQuoteCopy
  // a title for each line the server pointed at (the cart knows the model names)
  lineTitle?: (index: number) => string | null
  // shown to a signed-in customer: the account's email is used when the field is left empty
  signedIn?: boolean
}

type State =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'sent'; orderNumber: number }
  | { phase: 'error'; message: string }

export default function ManualQuoteForm({ request, failure, copy, lineTitle, signedIn }: Props) {
  const ids = { email: useId(), name: useId(), note: useId() }
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [state, setState] = useState<State>({ phase: 'idle' })
  const lock = useRef(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setState({ phase: 'sending' })
    try {
      const result = await requestManualQuote({ request, email, name, note })
      if (result.ok) { setState({ phase: 'sent', orderNumber: result.orderNumber }); return }
      const code = result.failure.code
      const known = copy.errors as Record<string, string>
      setState({ phase: 'error', message: known[code] ?? (result.failure.kind === 'network' ? copy.errors.NETWORK : result.failure.kind === 'busy' ? copy.errors.RATE_LIMITED : copy.errors.OTHER) })
    } catch {
      setState({ phase: 'error', message: copy.errors.OTHER })
    } finally {
      lock.current = false
    }
  }

  if (state.phase === 'sent') {
    return (
      <div role="status" data-testid="manual-quote-sent" className="mt-3 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-100">
        <p className="font-medium">{copy.sentTitle}</p>
        <p className="mt-1">{copy.sent(formatOrderNumber(state.orderNumber), email.trim())}</p>
      </div>
    )
  }

  const sending = state.phase === 'sending'
  return (
    <section data-testid="manual-quote" aria-labelledby={`${ids.email}-title`} className="mt-3 rounded-lg border border-white/15 bg-black/20 px-3 py-3 text-sm">
      <h3 id={`${ids.email}-title`} className="font-semibold">{copy.title}</h3>
      {failure.reviews?.length ? (
        <ul className="mt-2 space-y-1 text-xs text-slate-300" data-testid="manual-quote-reasons">
          {failure.reviews.map((line) => (
            <li key={line.itemIndex} className="break-words">
              <span className="font-medium">{lineTitle?.(line.itemIndex) ?? copy.line(line.itemIndex + 1)}</span>
              {': '}
              {line.reasons.map((reason) => copy.reason(reason)).join('; ')}.
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-xs text-slate-300">{copy.intro}</p>
      <form onSubmit={submit} className="mt-3 space-y-3" noValidate>
        <div>
          <label htmlFor={ids.email} className="block text-xs text-slate-300">{copy.emailLabel}</label>
          <input id={ids.email} data-testid="manual-quote-email" type="email" inputMode="email" autoComplete="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} className="input mt-1 min-h-11 w-full" />
          {!signedIn ? <p className="mt-1 text-[11px] text-slate-400">{copy.emailHint}</p> : null}
        </div>
        <div>
          <label htmlFor={ids.name} className="block text-xs text-slate-300">{copy.nameLabel}</label>
          <input id={ids.name} type="text" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className="input mt-1 min-h-11 w-full" />
        </div>
        <div>
          <label htmlFor={ids.note} className="block text-xs text-slate-300">{copy.noteLabel}</label>
          <textarea id={ids.note} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={copy.notePlaceholder} className="input mt-1 w-full" />
        </div>
        {state.phase === 'error' ? <p role="alert" data-testid="manual-quote-error" className="text-xs text-red-300">{state.message}</p> : null}
        <button type="submit" data-testid="manual-quote-send" disabled={sending} aria-busy={sending} className="btn min-h-11 w-full sm:w-auto disabled:opacity-60">
          {sending ? copy.sending : copy.send}
        </button>
      </form>
    </section>
  )
}
