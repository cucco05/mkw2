'use client'

import { useState } from 'react'

type StripePaymentPanelProps = {
  orderId: string
  paymentIntentId?: string | null
  paymentStatus?: string | null
  chargeId?: string | null
  customerId?: string | null
  receiptUrl?: string | null
  invoiceId?: string | null
  hostedInvoiceUrl?: string | null
  invoicePdfUrl?: string | null
  totalCents: number
  refundedCents?: number | null
  currency: string
}

function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(cents / 100)
}

export default function StripePaymentPanel({
  orderId,
  paymentIntentId,
  paymentStatus,
  chargeId,
  customerId,
  receiptUrl,
  invoiceId,
  hostedInvoiceUrl,
  invoicePdfUrl,
  totalCents,
  refundedCents,
  currency,
}: StripePaymentPanelProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [attachPaymentIntentId, setAttachPaymentIntentId] = useState(paymentIntentId || '')
  const [attachReason, setAttachReason] = useState('')
  const [attachProblems, setAttachProblems] = useState<Array<{ check: string; message: string }>>([])
  const remainingCents = Math.max(0, totalCents - (refundedCents || 0))

  async function attachPaymentIntent() {
    setBusy('attach')
    setMessage(null)
    setAttachProblems([])
    try {
      const trimmed = attachPaymentIntentId.trim()
      const res = await fetch(`/api/admin/orders/${orderId}/stripe-attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: trimmed, reason: attachReason.trim() }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        if (Array.isArray(data?.failed)) setAttachProblems(data.failed)
        throw new Error(data?.failed ? 'The PaymentIntent was not linked. The order stays unpaid.' : (data?.error || 'Stripe attach failed'))
      }
      setMessage(`Attached: ${data.paymentIntentId}`)
      window.location.reload()
    } catch (err: any) {
      setMessage(err?.message || 'Stripe attach failed')
    } finally {
      setBusy(null)
    }
  }

  async function sync() {
    setBusy('sync')
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/stripe-sync`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || 'Stripe sync failed')
      setMessage(`Synced: ${data.paymentStatus || 'unknown'}`)
      window.location.reload()
    } catch (err: any) {
      setMessage(err?.message || 'Stripe sync failed')
    } finally {
      setBusy(null)
    }
  }

  async function refund() {
    setBusy('refund')
    setMessage(null)
    try {
      const trimmed = amount.trim()
      const amountCents = trimmed ? Math.round(Number(trimmed) * 100) : undefined
      const res = await fetch(`/api/admin/orders/${orderId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountCents, reason: 'requested_by_customer' }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || 'Refund failed')
      setMessage(`Refund created: ${formatMoney(data.amount || 0, currency)}`)
      window.location.reload()
    } catch (err: any) {
      setMessage(err?.message || 'Refund failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-xl border border-white/10 p-4 bg-black/20 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Stripe</h2>
        <span className="text-xs rounded-md border border-white/10 px-2 py-1 text-slate-300">
          {paymentStatus || 'unknown'}
        </span>
      </div>
      <div className="grid gap-2 text-xs text-slate-300">
        <div>
          <p className="text-slate-500">PaymentIntent</p>
          <p className="break-all">{paymentIntentId || 'Not recorded'}</p>
        </div>
        <div>
          <p className="text-slate-500">Charge</p>
          <p className="break-all">{chargeId || 'Not recorded'}</p>
        </div>
        <div>
          <p className="text-slate-500">Customer</p>
          <p className="break-all">{customerId || 'Not recorded'}</p>
        </div>
        <div>
          <p className="text-slate-500">Invoice</p>
          <p className="break-all">{invoiceId || 'Not recorded'}</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-slate-500">Refunded</p>
            <p>{formatMoney(refundedCents || 0, currency)} of {formatMoney(totalCents, currency)}</p>
          </div>
          <div className="flex items-center gap-2">
            {receiptUrl ? (
              <a className="text-xs underline underline-offset-4 hover:text-white" href={receiptUrl} target="_blank" rel="noreferrer">
                Receipt
              </a>
            ) : null}
            {hostedInvoiceUrl ? (
              <a className="text-xs underline underline-offset-4 hover:text-white" href={hostedInvoiceUrl} target="_blank" rel="noreferrer">
                Invoice
              </a>
            ) : null}
            {invoicePdfUrl ? (
              <a className="text-xs underline underline-offset-4 hover:text-white" href={invoicePdfUrl} target="_blank" rel="noreferrer">
                PDF
              </a>
            ) : null}
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Attach PaymentIntent</p>
        <p className="text-xs text-slate-400">
          Administrators only. Stripe is asked for the payment; it is linked only if the payment itself names this order (its Stripe metadata carries this order&apos;s id) and the amount, currency and state match.
          A payment taken outside Stripe is registered as a manual payment instead.
        </p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <input
            value={attachPaymentIntentId}
            onChange={(event) => setAttachPaymentIntentId(event.target.value)}
            placeholder="pi_..."
            aria-label="Stripe PaymentIntent id"
            className="min-h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
          />
          <input
            value={attachReason}
            onChange={(event) => setAttachReason(event.target.value)}
            placeholder="Why (at least 10 characters)"
            aria-label="Reason for linking the payment"
            maxLength={300}
            className="min-h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
          />
          <button
            type="button"
            onClick={attachPaymentIntent}
            disabled={busy !== null || !attachPaymentIntentId.trim() || attachReason.trim().length < 10}
            className="min-h-11 rounded-md border border-white/15 px-4 py-2 text-sm hover:border-white/40 disabled:opacity-50"
          >
            {busy === 'attach' ? 'Checking...' : 'Attach PaymentIntent'}
          </button>
        </div>
        {attachProblems.length > 0 ? (
          <ul className="space-y-1 rounded-md border border-rose-300/30 bg-rose-500/10 p-2 text-xs text-rose-100" role="alert">
            {attachProblems.map((problem, index) => <li key={`${problem.check}-${index}`}><span className="font-semibold">{problem.check.replace(/_/g, ' ')}:</span> {problem.message}</li>)}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={sync}
          disabled={busy !== null || !paymentIntentId}
          className="min-h-11 rounded-md border border-white/15 px-4 py-2 text-sm hover:border-white/40 disabled:opacity-50"
        >
          {busy === 'sync' ? 'Syncing...' : 'Sync Stripe'}
        </button>
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder={formatMoney(remainingCents, currency)}
          className="min-h-11 w-28 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
        />
        <button
          type="button"
          onClick={refund}
          disabled={busy !== null || !paymentIntentId || remainingCents <= 0}
          className="min-h-11 rounded-md border border-rose-300/30 px-4 py-2 text-sm text-rose-100 hover:border-rose-200 disabled:opacity-50"
        >
          {busy === 'refund' ? 'Refunding...' : 'Refund'}
        </button>
      </div>
      {message ? <p className="text-xs text-slate-300">{message}</p> : null}
    </div>
  )
}
