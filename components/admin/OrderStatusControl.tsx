'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ORDER_STATUS_FLOW, isAwaitingStatus, normalizeOrderStatus, statusLabel } from '@/lib/order-status'
import { pushSessionNotification } from '@/components/notifications/NotificationsProvider'
import { isCreditPaymentMethod, type ReleaseView } from '@/lib/order-payment-policy'

type FlowStatus = (typeof ORDER_STATUS_FLOW)[number]['key']

type Props = {
  orderId: string
  status: string
  failureNote?: string | null
  // What the server decided about releasing this order into production (lib/order-payment-policy.ts). It only EXPLAINS: the server decides again on every change.
  release?: Pick<ReleaseView, 'released' | 'authorizable' | 'label' | 'detail' | 'state'> | null
  // Only an administrator (not staff) can authorize production without a verified payment.
  canAuthorize?: boolean
  // The agreed payment method: an invoice or purchase-order order is produced on CREDIT (a commercial credit, with the reference of the invoice or order), not on an exceptional authorization.
  paymentMethod?: string | null
}

// The refusals that an administrator may answer with a written authorization. A payment that is held, being confirmed or still open is NOT in this list: nothing
// overrides it, so the screen only says why.
// (a refund in progress is NOT in the list either: while the money is leaving nothing overrides the block)
const ASKS_FOR_AUTHORIZATION = ['PAYMENT_NOT_VERIFIED', 'PAYMENT_UNPROVEN', 'PAYMENT_REFUNDED', 'EXTERNAL_ORDER_NOT_AUTHORIZED']
const REASON_MIN_LENGTH = 10
const CREDIT_REFERENCE_MAX = 120

type Ask = { kind: 'authorize' | 'cancel'; body: Record<string, unknown>; message: string }

export default function OrderStatusControl({ orderId, status, failureNote, release, canAuthorize = true, paymentMethod = null }: Props) {
  const router = useRouter()
  const normalized = useMemo(() => normalizeOrderStatus(status), [status])
  const [value, setValue] = useState<FlowStatus>(normalized)
  const initialFailureNote = useMemo(() => (failureNote || '').trim(), [failureNote])
  const [failureNoteInput, setFailureNoteInput] = useState(initialFailureNote)
  const [pending, setPending] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [reason, setReason] = useState('')
  // production on credit (an invoice or purchase-order order): the reference of the invoice / order, and when it is due
  const [creditReference, setCreditReference] = useState('')
  const [creditDueAt, setCreditDueAt] = useState('')
  const onCredit = isCreditPaymentMethod(paymentMethod) && release?.state !== 'external_review'

  useEffect(() => {
    setFailureNoteInput(initialFailureNote)
  }, [initialFailureNote])
  useEffect(() => {
    setValue(normalized)
  }, [normalized])

  const dirty = value !== normalized || (value === 'failed' && failureNoteInput.trim() !== initialFailureNote)
  const awaiting = isAwaitingStatus(status)

  // Sends a status change. The server may answer that the order is not released: an administrator is then asked, here on the page, for a written authorization
  // (recorded on the order and in the audit log); cancelling an order that already went to production asks for a written reason too. Anything else is shown as it is.
  const send = async (body: Record<string, unknown>): Promise<{ ok: boolean; asked: boolean; data: any }> => {
    const res = await fetch(`/api/admin/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 409 && canAuthorize && ASKS_FOR_AUTHORIZATION.includes(data?.code)) {
      setAsk({ kind: 'authorize', body, message: data.error })
      setReason('')
      setCreditReference('')
      setCreditDueAt('')
      return { ok: false, asked: true, data }
    }
    if (res.status === 409 && data?.code === 'CANCELLATION_REASON_REQUIRED') {
      setAsk({ kind: 'cancel', body, message: data.error })
      setReason('')
      return { ok: false, asked: true, data }
    }
    if (!res.ok) {
      const note = ASKS_FOR_AUTHORIZATION.includes(data?.code) && !canAuthorize ? ' Only an administrator can authorize production without a verified payment.' : ''
      throw new Error(`${data?.error || 'Failed to update status.'}${note}`)
    }
    if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
      pushSessionNotification({ type: 'info', title: 'Saved - check this', message: data.warnings.join(' ') })
    }
    return { ok: true, asked: false, data }
  }

  const run = async (body: Record<string, unknown>, done: { title: string; message: string }, failedTitle: string) => {
    if (pending) return false
    setPending(true)
    try {
      const result = await send(body)
      if (!result.ok) return false
      setAsk(null)
      pushSessionNotification({ type: 'success', title: done.title, message: done.message })
      router.refresh()
      return true
    } catch (err: any) {
      setAsk(null)
      pushSessionNotification({ type: 'error', title: failedTitle, message: err?.message || 'Unable to update status.' })
      setValue(normalized)
      return false
    } finally {
      setPending(false)
    }
  }

  const label = (key: string) => ORDER_STATUS_FLOW.find((s) => s.key === key)?.label || key
  const save = () => {
    if (!dirty) return
    void run(
      value === 'failed' ? { status: value, failureNote: failureNoteInput.trim() || undefined } : { status: value },
      { title: 'Status updated', message: `Order set to ${label(value)}.` },
      'Update failed',
    )
  }
  const requeue = () => void run({ status: 'queued' }, { title: 'Order requeued', message: 'Order moved back to queued.' }, 'Requeue failed')
  const moveToQueue = () => void run({ status: 'queued' }, { title: 'Order queued', message: 'Order moved to the queue.' }, 'Queueing failed')

  const creditMissing = Boolean(ask?.kind === 'authorize' && onCredit && creditReference.trim().length < 1)
  const confirmAsk = async () => {
    if (!ask || pending || reason.trim().length < REASON_MIN_LENGTH || creditMissing) return
    const body = ask.kind === 'authorize'
      ? {
        ...ask.body, authorizeUnpaid: true, authorizationReason: reason.trim(),
        ...(onCredit ? { authorizationKind: 'commercial_credit', creditReference: creditReference.trim(), ...(creditDueAt.trim() ? { creditDueAt: creditDueAt.trim() } : {}) } : {}),
      }
      : { ...ask.body, cancellationReason: reason.trim() }
    const target = String(ask.body.status || '')
    await run(body, { title: 'Status updated', message: `Order set to ${label(target)}.` }, 'Update failed')
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-400" data-testid="status-current">Current status: <span className="font-medium text-slate-200">{statusLabel(status)}</span></p>
      {release && !release.released ? (
        <p className="break-words rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-100" data-testid="status-release-note">
          {release.label}.{' '}
          {release.authorizable
            ? (canAuthorize ? 'Moving it into production asks you for a written authorization.' : 'Only an administrator can authorize production for it.')
            : 'No authorization can release it: the payment, or the refund, has to be settled first.'}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="New status"
          className="min-h-11 rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
          value={value}
          onChange={(e) => setValue(e.target.value as FlowStatus)}
          disabled={pending}
        >
          {ORDER_STATUS_FLOW.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || pending}
          className="min-h-11 px-3 py-1.5 rounded-md border border-white/10 hover:border-white/30 text-sm disabled:opacity-60"
        >
          {pending ? 'Saving...' : 'Update'}
        </button>
        {awaiting ? (
          <button
            type="button"
            onClick={moveToQueue}
            disabled={pending}
            data-testid="status-move-to-queue"
            className="min-h-11 px-3 py-1.5 rounded-md border border-white/15 hover:border-white/40 text-sm disabled:opacity-60"
          >
            Move to queue
          </button>
        ) : null}
        {normalized === 'failed' ? (
          <button
            type="button"
            onClick={requeue}
            disabled={pending}
            className="min-h-11 px-3 py-1.5 rounded-md border border-emerald-400/40 text-emerald-200 hover:border-emerald-300 text-sm disabled:opacity-60"
          >
            Requeue
          </button>
        ) : null}
      </div>
      {value === 'failed' ? (
        <div className="space-y-1">
          <p className="text-xs text-slate-400">Failure note</p>
          <textarea
            className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white"
            rows={2}
            value={failureNoteInput}
            onChange={(e) => setFailureNoteInput(e.target.value)}
            placeholder="What went wrong?"
            disabled={pending}
          />
        </div>
      ) : null}
      {ask ? (
        <form
          className="space-y-2 rounded-lg border border-white/15 bg-black/30 p-3"
          data-testid="status-ask"
          onSubmit={(event) => { event.preventDefault(); void confirmAsk() }}
        >
          <p className="break-words text-xs text-slate-200" role="alert">{ask.message}</p>
          <label className="block space-y-1 text-xs text-slate-400">
            <span>{ask.kind === 'authorize'
              ? (onCredit ? 'Why production may start before the money arrives (recorded under your name; at least 10 characters)' : 'Why production may start without a verified payment (recorded under your name; at least 10 characters)')
              : 'Why the order is cancelled (at least 10 characters)'}</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
              className="min-h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
            />
          </label>
          {ask.kind === 'authorize' && onCredit ? (
            <>
              <p className="break-words text-xs text-slate-300" data-testid="status-credit-note">
                This is a commercial credit, not a payment: the order stays unpaid and the amount stays due until the money arrives.
              </p>
              <label className="block space-y-1 text-xs text-slate-400">
                <span>Invoice or purchase-order reference (required)</span>
                <input
                  value={creditReference}
                  onChange={(event) => setCreditReference(event.target.value)}
                  maxLength={CREDIT_REFERENCE_MAX}
                  autoComplete="off"
                  className="min-h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </label>
              <label className="block space-y-1 text-xs text-slate-400">
                <span>Due date (optional)</span>
                <input
                  type="date"
                  value={creditDueAt}
                  onChange={(event) => setCreditDueAt(event.target.value)}
                  className="min-h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </label>
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending || reason.trim().length < REASON_MIN_LENGTH || creditMissing}
              className="min-h-11 rounded-md border border-white/15 px-4 py-2 text-sm hover:border-white/40 disabled:opacity-50"
            >
              {ask.kind === 'authorize' ? 'Authorize and update' : 'Cancel the order with this reason'}
            </button>
            <button
              type="button"
              onClick={() => { setAsk(null); setValue(normalized) }}
              disabled={pending}
              className="min-h-11 rounded-md border border-white/10 px-4 py-2 text-sm hover:border-white/30 disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
