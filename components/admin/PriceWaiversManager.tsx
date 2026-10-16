"use client"
// Grant and revoke minimum-price waivers (lib/minimum-waivers.ts). The server checks everything again: the role, the reason, that the figure is under the shop's
// minimum, that the target exists, that it has no other active waiver. Amounts are typed in euros and sent as whole cents.
import { useState } from 'react'

type Waiver = {
  id: string
  targetType: 'model' | 'product'
  targetId: string
  targetTitle: string | null
  minimumPriceCents: number
  reason: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  revokeReason: string | null
  active: boolean
}
type Overview = {
  commonMinimumCents: number
  waivers: Waiver[]
  fixedPricesWithoutWaiver: Array<{ id: string; title: string; salePriceCents: number }>
  productsToCheck: Array<{ id: string; title: string; multiplier: number }>
}

const euros = (cents: number) => (cents / 100).toFixed(2)
const REASON_MIN = 10

export default function PriceWaiversManager({ initial }: { initial: Overview }) {
  const [overview, setOverview] = useState<Overview>(initial)
  const [targetType, setTargetType] = useState<'model' | 'product'>('model')
  const [targetId, setTargetId] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [revoking, setRevoking] = useState<{ id: string; reason: string } | null>(null)

  async function refresh() {
    const res = await fetch('/api/admin/price-waivers', { cache: 'no-store' })
    if (res.ok) setOverview(await res.json())
  }

  const cents = Math.round(Number(amount.replace(',', '.')) * 100)
  const amountOk = amount.trim() !== '' && Number.isFinite(cents) && cents >= 0 && cents < overview.commonMinimumCents
  const canGrant = targetId.trim().length > 0 && amountOk && reason.trim().length >= REASON_MIN && !busy

  async function grant() {
    setBusy(true); setMessage(null)
    try {
      const res = await fetch('/api/admin/price-waivers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { type: targetType, id: targetId.trim() }, minimumPriceCents: cents, reason: reason.trim(),
          ...(expires ? { expiresAt: new Date(`${expires}T23:59:59`).toISOString() } : {}),
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) { setMessage({ ok: false, text: body?.error || 'The waiver could not be recorded.' }); return }
      setMessage({ ok: true, text: 'Waiver recorded. It applies to carts priced from now on; orders already made keep their price.' })
      setTargetId(''); setAmount(''); setReason(''); setExpires('')
      await refresh()
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' })
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    if (!revoking) return
    setBusy(true); setMessage(null)
    try {
      const res = await fetch(`/api/admin/price-waivers/${revoking.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: revoking.reason.trim() }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) { setMessage({ ok: false, text: body?.error || 'The revocation could not be recorded.' }); return }
      setMessage({ ok: true, text: 'Waiver revoked. Orders already made keep their price.' })
      setRevoking(null)
      await refresh()
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-300" data-testid="common-minimum">Shop minimum per unit: <strong>{euros(overview.commonMinimumCents)}</strong></p>

      <section className="rounded-xl border border-white/10 bg-black/20 p-4 sm:p-5 space-y-4" aria-labelledby="grant-title">
        <h2 id="grant-title" className="text-lg font-semibold">Grant a waiver</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-slate-300">
            <span className="block">Applies to</span>
            <select className="input mt-1 min-h-11 w-full" value={targetType} onChange={(e) => setTargetType(e.target.value as 'model' | 'product')}>
              <option value="model">A model</option>
              <option value="product">A ready-made product</option>
            </select>
          </label>
          <label className="block text-xs text-slate-300">
            <span className="block">Id of the {targetType}</span>
            <input className="input mt-1 min-h-11 w-full" value={targetId} maxLength={64} onChange={(e) => setTargetId(e.target.value)} />
          </label>
          <label className="block text-xs text-slate-300">
            <span className="block">Least price of ONE unit (euros)</span>
            <input className="input mt-1 min-h-11 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== '' && !amountOk} />
            <span className="mt-1 block text-[11px] text-slate-500">Must be under the shop minimum ({euros(overview.commonMinimumCents)}).</span>
          </label>
          <label className="block text-xs text-slate-300">
            <span className="block">Expires on (optional)</span>
            <input className="input mt-1 min-h-11 w-full" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        </div>
        <label className="block text-xs text-slate-300">
          <span className="block">Reason (written, at least {REASON_MIN} characters)</span>
          <textarea className="input mt-1 w-full" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {amountOk && targetId.trim() ? (
          <p className="text-sm text-slate-300" data-testid="waiver-preview">
            Each unit of this {targetType} will cost at least <strong>{euros(cents)}</strong> instead of {euros(overview.commonMinimumCents)}. Orders already made do not change.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn min-h-11" onClick={grant} disabled={!canGrant} aria-busy={busy}>Grant waiver</button>
          {message ? <p role={message.ok ? 'status' : 'alert'} className={`text-sm break-words ${message.ok ? 'text-emerald-300' : 'text-red-300'}`}>{message.text}</p> : null}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="inventory-title">
        <h2 id="inventory-title" className="text-lg font-semibold">Prices set by hand under the minimum, with no waiver</h2>
        <p className="text-xs text-slate-400">These are sold at the shop minimum today (a hand-set price is not an exemption). Grant a waiver only if the lower price is really intended.</p>
        {overview.fixedPricesWithoutWaiver.length === 0 ? <p className="text-sm text-slate-400">None.</p> : (
          <ul className="space-y-2" data-testid="inventory-models">
            {overview.fixedPricesWithoutWaiver.map((model) => (
              <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm">
                <span className="min-w-0 break-words">{model.title} · set at {euros(model.salePriceCents)}</span>
                <button type="button" className="btn min-h-11" onClick={() => { setTargetType('model'); setTargetId(model.id); setAmount(euros(model.salePriceCents)) }}>Prepare a waiver</button>
              </li>
            ))}
          </ul>
        )}
        {overview.productsToCheck.length > 0 ? (
          <>
            <h3 className="text-sm font-medium">Ready-made products with a price multiplier under 1 (may end under the minimum)</h3>
            <ul className="space-y-2" data-testid="inventory-products">
              {overview.productsToCheck.map((product) => (
                <li key={product.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm">
                  <span className="min-w-0 break-words">{product.title} · ×{product.multiplier}</span>
                  <button type="button" className="btn min-h-11" onClick={() => { setTargetType('product'); setTargetId(product.id) }}>Prepare a waiver</button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="list-title">
        <h2 id="list-title" className="text-lg font-semibold">Waivers</h2>
        {overview.waivers.length === 0 ? <p className="text-sm text-slate-400" data-testid="no-waivers">No waiver has been granted.</p> : (
          <ul className="space-y-2" data-testid="waiver-list">
            {overview.waivers.map((waiver) => (
              <li key={waiver.id} className="rounded-lg border border-white/10 px-3 py-3 text-sm space-y-1" data-testid="waiver-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words font-medium">{waiver.targetTitle || waiver.targetId} <span className="text-xs text-slate-400">({waiver.targetType})</span></span>
                  <span className={`text-xs ${waiver.active ? 'text-emerald-300' : 'text-slate-400'}`}>
                    {waiver.revokedAt ? 'Revoked' : waiver.active ? 'Active' : 'Expired'}
                  </span>
                </div>
                <div className="text-slate-300">At least {euros(waiver.minimumPriceCents)} per unit{waiver.expiresAt ? ` · until ${waiver.expiresAt.slice(0, 10)}` : ''}</div>
                <div className="text-xs text-slate-400 break-words">Reason: {waiver.reason}</div>
                {waiver.revokedAt ? <div className="text-xs text-slate-400 break-words">Revoked: {waiver.revokeReason}</div> : null}
                {waiver.active ? (
                  revoking?.id === waiver.id ? (
                    <div className="space-y-2 pt-1">
                      <textarea className="input w-full" rows={2} maxLength={300} placeholder={`Why is it revoked? (at least ${REASON_MIN} characters)`}
                        value={revoking.reason} onChange={(e) => setRevoking({ id: waiver.id, reason: e.target.value })} />
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="btn min-h-11" onClick={revoke} disabled={busy || revoking.reason.trim().length < REASON_MIN}>Confirm revocation</button>
                        <button type="button" className="min-h-11 rounded-md border border-white/10 px-3" onClick={() => setRevoking(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="min-h-11 rounded-md border border-white/10 px-3" onClick={() => setRevoking({ id: waiver.id, reason: '' })}>Revoke</button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
