"use client"

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { pushSessionNotification } from '@/components/notifications/NotificationsProvider'

type Props = {
  orderId: string
  disabled?: boolean
  // Why sending is not possible right now (the order is not released, or not queued). The server decides again when the button is pressed.
  blockedReason?: string | null
  // A note that does not block: for instance that an earlier call has an unknown outcome and pressing the button only looks for the job.
  note?: string | null
}

export default function PrintLabSubmitButton({ orderId, disabled, blockedReason, note }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const blocked = Boolean(blockedReason)

  const submit = async () => {
    if (busy || disabled || blocked) return
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/printlab-submit`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'PrintLab submission failed')
      const count = Array.isArray(data?.submitted) ? data.submitted.length : 0
      pushSessionNotification({
        type: 'success',
        title: 'Submitted to PrintLab',
        message: `${count} job${count === 1 ? '' : 's'} submitted to the PrintLab routing queue.`,
      })
      router.refresh()
    } catch (err: any) {
      pushSessionNotification({
        type: 'error',
        title: 'PrintLab submit failed',
        message: err?.message || 'Unable to submit this order to PrintLab.',
      })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-w-0 space-y-1">
      <button
        type="button"
        className="min-h-11 text-sm px-3 py-1.5 rounded-md border border-brand-500/60 bg-brand-500/15 text-white hover:border-brand-400 disabled:opacity-50"
        onClick={submit}
        disabled={busy || disabled || blocked}
        aria-describedby={blocked ? `printlab-submit-reason-${orderId}` : undefined}
      >
        {busy ? 'Submitting to PrintLab...' : 'Submit to PrintLab'}
      </button>
      {blocked ? <p id={`printlab-submit-reason-${orderId}`} className="break-words text-xs text-amber-200" data-testid="printlab-submit-reason">{blockedReason}</p> : null}
      {note ? <p className="break-words text-xs text-slate-400" data-testid="printlab-submit-note">{note}</p> : null}
    </div>
  )
}
