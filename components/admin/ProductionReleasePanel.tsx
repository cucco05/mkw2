'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { pushSessionNotification } from '@/components/notifications/NotificationsProvider'
import type { ReleaseView } from '@/lib/order-payment-policy'

// The "Production release" card of the administrator's order page (step 4.6, S4): why this order is, or is not, allowed into production - and what the outside
// services were told about it. It only DESCRIBES the decision the server takes (lib/order-payment-policy.ts); every button elsewhere on the page is still checked
// by the server again. The one action here confirms that an outside call DID happen, by naming its record - the server looks that record up; nothing here
// sends a call again or says "it did not happen".

export type ReleasePanelEffect = {
  key: string
  kind: 'printlab_submit' | 'stockworks_movement'
  state: 'intent' | 'confirmed' | 'rejected' | 'not_sent' | 'uncertain'
  summary: string
  cause: string | null
  message: string | null
  externalId: string | null
  confirmedBy: 'response' | 'reconciliation' | 'admin_proof' | null
  startedAt: string
  at: string
  attempts: number
  blockedAfterSend: boolean
  // an intent whose call may still be running (its claim has not run out)
  claimLive: boolean
}

export type ReleasePanelProps = {
  orderId: string
  orderStatus: string
  release: ReleaseView
  // payment in order, but the order still says "awaiting payment / review": it has not been moved into the queue
  waitingForAdmin: boolean
  authorization: { by: string; byName: string | null; at: string; reason: string | null } | null
  // a payment attested by an administrator (step 4.6, S6): how the money was received, the bank reference, and the amount - which is the order's, never typed
  manualPayment: { by: string; at: string; reason: string; method: string; receivedVia?: string | null; reference?: string | null; amountCents?: number | null; currency?: string | null } | null
  printLab: { reported: string | null; wouldSetStatus: string | null }
  effects: ReleasePanelEffect[]
  evidence: string[]
  // only an administrator (not staff) may confirm an outside effect
  canConfirm: boolean
}

const EVIDENCE_TEXT: Record<string, string> = {
  printlab_job_confirmed: 'a PrintLab job was created',
  printlab_outcome_unknown: 'a call to PrintLab has an unknown outcome',
  material_consumed: 'material was taken out of stock',
  material_outcome_unknown: 'a StockWorks movement has an unknown outcome',
  printlab_submission_recorded: 'a PrintLab submission is recorded',
  production_started: 'the status says production started',
  production_finished: 'the status says production finished',
}

const STATE_TEXT: Record<ReleasePanelEffect['state'], string> = {
  confirmed: 'Done',
  intent: 'Being sent',
  rejected: 'Refused by the service',
  not_sent: 'Not sent',
  uncertain: 'Outcome unknown',
}

// UTC on purpose: the same text on the server and in the browser, whatever the time zone of either (a client component is rendered on both)
function when(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`
}

function tone(release: ReleaseView) {
  if (release.released) return 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
  if (release.state === 'payment_hold' || release.state === 'payment_processing' || release.state === 'payment_active' || release.state === 'payment_refund_pending') return 'border-amber-400/40 bg-amber-500/10 text-amber-100'
  if (release.state === 'external_review' || release.state === 'payment_unproven' || release.state === 'payment_refunded') return 'border-sky-400/40 bg-sky-500/10 text-sky-100'
  return 'border-white/15 bg-white/5 text-slate-200'
}

function money(cents: number | null | undefined, currency: string | null | undefined) {
  const amount = Math.max(0, Number.isFinite(Number(cents)) ? Number(cents) : 0) / 100
  const code = (currency || 'USD').toUpperCase()
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount) } catch { return `${code} ${amount.toFixed(2)}` }
}
const RECEIVED_VIA_TEXT: Record<string, string> = { cash: 'received in cash', bank_transfer: 'received by bank transfer', none: 'no charge' }

function effectTone(state: ReleasePanelEffect['state']) {
  if (state === 'confirmed') return 'border-emerald-400/30 text-emerald-100'
  if (state === 'uncertain' || state === 'intent') return 'border-rose-400/40 text-rose-100'
  return 'border-white/15 text-slate-200'
}

function ConfirmEffectForm({ orderId, effect }: { orderId: string; effect: ReleasePanelEffect }) {
  const router = useRouter()
  const [externalId, setExternalId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const service = effect.kind === 'printlab_submit' ? 'PrintLab' : 'StockWorks'
  const idLabel = effect.kind === 'printlab_submit' ? 'PrintLab job id' : 'StockWorks movement id'
  const ready = externalId.trim().length > 0 && reason.trim().length >= 10

  async function confirm() {
    if (busy || !ready) return
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/external-effects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ effectKey: effect.key, externalId: externalId.trim(), reason: reason.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'The record could not be verified.')
      pushSessionNotification({ type: 'success', title: 'Outcome confirmed', message: `The record was found on ${service} and belongs to this order.` })
      router.refresh()
    } catch (err: any) {
      setProblem(err?.message || 'The record could not be verified.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-2 rounded-lg border border-white/10 bg-black/30 p-3"
      data-testid="release-confirm-form"
      onSubmit={(event) => { event.preventDefault(); void confirm() }}
    >
      <p className="break-words text-xs text-slate-300">
        Look in {service} for the record this call would have made. If you find it, enter its id: the server fetches it from {service} and checks that it belongs to this order.
        Not finding it proves nothing, and nothing on this page sends the call again.
      </p>
      <label className="block space-y-1 text-xs text-slate-400">
        <span>{idLabel}</span>
        <input
          value={externalId}
          onChange={(event) => setExternalId(event.target.value)}
          maxLength={200}
          autoComplete="off"
          className="min-h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
        />
      </label>
      <label className="block space-y-1 text-xs text-slate-400">
        <span>Why you are sure (at least 10 characters)</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={300}
          className="min-h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
        />
      </label>
      <button
        type="submit"
        disabled={busy || !ready}
        className="min-h-11 rounded-md border border-white/15 px-4 py-2 text-sm hover:border-white/40 disabled:opacity-50"
      >
        {busy ? 'Checking the record...' : `Confirm with the ${service} record`}
      </button>
      {problem ? <p className="break-words text-xs text-rose-200" role="alert" data-testid="release-confirm-problem">{problem}</p> : null}
    </form>
  )
}

export default function ProductionReleasePanel({
  orderId, orderStatus, release, waitingForAdmin, authorization, manualPayment, printLab, effects, evidence, canConfirm,
}: ReleasePanelProps) {
  const unresolved = effects.filter((effect) => effect.state === 'uncertain' || (effect.state === 'intent' && !effect.claimLive))
  const stateLabel = waitingForAdmin ? `${release.label} - waiting for an administrator` : release.label
  const showPrintLab = Boolean(printLab.reported) && (!release.released || (printLab.wouldSetStatus && printLab.wouldSetStatus !== orderStatus))

  return (
    <section
      aria-labelledby={`release-title-${orderId}`}
      data-testid="production-release-card"
      className="min-w-0 space-y-3 rounded-xl border border-white/10 bg-black/20 p-4"
    >
      <h2 id={`release-title-${orderId}`} className="text-lg font-semibold">Production release</h2>
      <p className={`inline-block max-w-full break-words rounded-lg border px-2 py-1 text-xs ${tone(release)}`} data-testid="release-state">{stateLabel}</p>
      <p className="break-words text-xs text-slate-300">{waitingForAdmin ? 'The payment is in order, but the order has not been moved into the queue yet. Set it to Queued when you want it produced.' : release.detail}</p>
      {release.activeUntil ? <p className="text-xs text-slate-400">A payment page may still be open until {when(release.activeUntil)}.</p> : null}

      {release.basis === 'admin_authorization' && authorization ? (
        <p className="break-words text-xs text-slate-300" data-testid="release-authorization">
          Authorized by {authorization.byName || authorization.by}{authorization.at ? ` on ${when(authorization.at)}` : ''}{authorization.reason ? `: ${authorization.reason}` : '.'}
          {' '}This is an administrator&apos;s decision, not a payment.
        </p>
      ) : null}
      {release.basis === 'commercial_credit' && release.credit ? (
        <p className="break-words text-xs text-slate-300" data-testid="release-credit">
          Commercial credit ({release.credit.method} {release.credit.reference}): {money(release.credit.amountDueCents, release.credit.currency)} is still due{release.credit.dueAt ? `, by ${release.credit.dueAt}` : ''}.
          {' '}This is an administrator&apos;s decision to produce before the money arrives - not a payment. The order stays unpaid until it does.
        </p>
      ) : null}
      {release.authorizationStale ? (
        <p className="break-words rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-100" data-testid="release-authorization-stale">
          {release.authorizationStale === 'no_revision'
            ? 'An authorization from before this safeguard exists, but it records nothing about what it was given for: it is not valid. Decide again, with a written reason.'
            : 'An administrator authorized production earlier, but the money of this order changed after that (a payment, a refund, a dispute, a decision about the payment or the total). That authorization is no longer valid: decide again, with a written reason.'}
        </p>
      ) : null}
      {manualPayment ? (
        <p className="break-words text-xs text-slate-300" data-testid="release-manual-payment">
          Manual payment registered by {manualPayment.by} on {when(manualPayment.at)} ({manualPayment.method}
          {manualPayment.receivedVia ? `, ${RECEIVED_VIA_TEXT[manualPayment.receivedVia] ?? manualPayment.receivedVia}` : ''}
          {manualPayment.reference ? `, reference ${manualPayment.reference}` : ''}
          {typeof manualPayment.amountCents === 'number' ? `, ${money(manualPayment.amountCents, manualPayment.currency)}` : ''}): {manualPayment.reason}. It was taken outside Stripe.
        </p>
      ) : null}
      {release.reviewReason ? <p className="break-all text-xs text-slate-500">Review code: {release.reviewReason}</p> : null}

      {showPrintLab ? (
        <p className="break-words text-xs text-amber-200" data-testid="release-printlab">
          PrintLab reported &quot;{printLab.reported}&quot; for this order.
          {release.released
            ? ` The order is "${orderStatus.replace(/_/g, ' ')}"; if PrintLab is right, set the status by hand.`
            : ' It was recorded, but the order was not moved because it is not released.'}
        </p>
      ) : null}

      {effects.length > 0 ? (
        <div className="space-y-2" data-testid="release-effects">
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Calls to outside services</p>
          <ul className="space-y-2">
            {effects.map((effect) => {
              const needsProof = effect.state === 'uncertain' || (effect.state === 'intent' && !effect.claimLive)
              return (
                <li key={effect.key} className={`min-w-0 space-y-1 rounded-lg border p-2 ${effectTone(effect.state)}`} data-testid={needsProof ? 'release-effect-uncertain' : 'release-effect'}>
                  <p className="break-all text-xs font-medium">{effect.summary}</p>
                  <p className="break-words text-xs text-slate-400">
                    {STATE_TEXT[effect.state]}{effect.cause ? ` - ${effect.cause.replace(/_/g, ' ')}` : ''}{effect.attempts > 1 ? ` - ${effect.attempts} attempts` : ''}{effect.at ? ` - ${when(effect.at)}` : ''}
                  </p>
                  {effect.message ? <p className="break-words text-xs text-slate-400">{effect.message}</p> : null}
                  {effect.state === 'intent' && effect.claimLive ? <p className="text-xs text-slate-400">The call is being made right now. Reload in a moment.</p> : null}
                  {effect.confirmedBy === 'admin_proof' ? <p className="text-xs text-slate-400">Confirmed by an administrator against the record on the outside service.</p> : null}
                  {effect.blockedAfterSend ? <p className="break-words text-xs text-amber-200">The order was put on hold while this call was being made. The call was not undone.</p> : null}
                  {needsProof ? (
                    <>
                      <p className="break-words text-xs text-rose-200">
                        {effect.state === 'intent'
                          ? 'The call started but its end was never recorded (the process may have stopped). It is treated as unknown: it will not be sent again by itself.'
                          : 'Nobody knows whether the service did this. It will not be sent again by itself.'}
                      </p>
                      {canConfirm ? <ConfirmEffectForm orderId={orderId} effect={effect} /> : <p className="text-xs text-slate-400">Only an administrator can settle this.</p>}
                    </>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {unresolved.length > 0 ? <p className="break-words text-xs text-slate-400">While an outcome is unknown the order stays blocked for that service: the call is only unblocked by the record itself.</p> : null}
        </div>
      ) : null}

      {evidence.length > 0 ? (
        <p className="break-words text-xs text-slate-400" data-testid="release-evidence">
          This order already went to production: {evidence.map((item) => EVIDENCE_TEXT[item] ?? item.replace(/_/g, ' ')).join('; ')}. It can not be deleted. To cancel it, first stop or cancel the job in PrintLab yourself, then cancel the order here with a written reason - nothing here stops a printer.
        </p>
      ) : null}
    </section>
  )
}
