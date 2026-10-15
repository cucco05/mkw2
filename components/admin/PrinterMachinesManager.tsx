"use client"
// Edit the machines that can make the orders (PrinterMachine). One card per machine; the server checks every value again (lib/printer-machines.ts).
import { useState } from 'react'

type Machine = {
  id?: string
  key: string
  label: string
  isActive: boolean
  buildXmm: number | string
  buildYmm: number | string
  buildZmm: number | string
  marginXYmm: number | string
  marginZmm: number | string
  supportMarginXYmm: number | string
  nozzleDiameterMm: number | string
  minFeatureMm: number | string | null
  maxSupportRatio: number | string | null
  allowedMaterials: string[]
  allowedFinishes: string[]
  notes: string | null
}

const NEW_MACHINE: Machine = {
  key: '', label: '', isActive: true, buildXmm: 180, buildYmm: 180, buildZmm: 180, marginXYmm: 3, marginZmm: 2, supportMarginXYmm: 3, nozzleDiameterMm: 0.4,
  minFeatureMm: null, maxSupportRatio: null, allowedMaterials: ['PLA'], allowedFinishes: ['standard'], notes: '',
}

const numberOrNull = (value: number | string | null) => (value === null || value === '' ? null : Number(value))

function payload(machine: Machine) {
  return {
    key: machine.key.trim(), label: machine.label.trim(), isActive: machine.isActive,
    buildXmm: Number(machine.buildXmm), buildYmm: Number(machine.buildYmm), buildZmm: Number(machine.buildZmm),
    marginXYmm: Number(machine.marginXYmm), marginZmm: Number(machine.marginZmm), supportMarginXYmm: Number(machine.supportMarginXYmm),
    nozzleDiameterMm: Number(machine.nozzleDiameterMm), minFeatureMm: numberOrNull(machine.minFeatureMm), maxSupportRatio: numberOrNull(machine.maxSupportRatio),
    allowedMaterials: machine.allowedMaterials, allowedFinishes: machine.allowedFinishes, notes: machine.notes?.trim() ? machine.notes.trim() : null,
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-slate-300">
      <span className="block">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-slate-500">{hint}</span> : null}
    </label>
  )
}

function Card({ initial, materials, finishes, onSaved }: { initial: Machine; materials: string[]; finishes: string[]; onSaved: (machine: Machine) => void }) {
  const [machine, setMachine] = useState<Machine>(initial)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const isNew = !machine.id
  const set = <K extends keyof Machine>(key: K, value: Machine[K]) => setMachine((current) => ({ ...current, [key]: value }))
  const toggle = (key: 'allowedMaterials' | 'allowedFinishes', value: string) => setMachine((current) => ({
    ...current,
    [key]: current[key].includes(value) ? current[key].filter((entry) => entry !== value) : [...current[key], value],
  }))

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch(isNew ? '/api/admin/printer-machines' : `/api/admin/printer-machines/${machine.id}`, {
        method: isNew ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(machine)),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const detail = Array.isArray(body?.issues) && body.issues.length ? ` ${body.issues.map((issue: any) => `${issue.path}: ${issue.message}`).join('; ')}` : ''
        setMessage({ ok: false, text: `${body?.error || 'Could not save.'}${detail}` })
        return
      }
      setMachine(body.machine)
      setMessage({ ok: true, text: 'Saved.' })
      onSaved(body.machine)
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' })
    } finally {
      setSaving(false)
    }
  }

  const num = (key: keyof Machine, step = 'any') => (
    <input className="input mt-1 min-h-11 w-full" type="number" inputMode="decimal" step={step} min="0" value={(machine[key] as number | string | null) ?? ''} onChange={(e) => set(key, e.target.value as any)} />
  )
  const check = (checked: boolean, label: string, onChange: () => void) => (
    <label key={label} className="flex min-h-11 items-center gap-2 rounded-md border border-white/10 px-3 text-sm">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  )

  return (
    <section className="rounded-xl border border-white/10 bg-black/20 p-4 sm:p-5 space-y-4" data-testid="machine-card">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input mt-1 min-h-11 w-full" value={machine.label} maxLength={80} onChange={(e) => set('label', e.target.value)} /></Field>
        <Field label="Key" hint={isNew ? 'Lowercase letters, digits and hyphens (e.g. bambu-p1s). Cannot be empty.' : 'Identifies the machine; change only if you must.'}>
          <input className="input mt-1 min-h-11 w-full" value={machine.key} maxLength={40} onChange={(e) => set('key', e.target.value)} />
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={machine.isActive} onChange={(e) => set('isActive', e.target.checked)} />
        <span>Active (orders can be made on this machine)</span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Build volume (mm, as the manufacturer states it)</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="X">{num('buildXmm')}</Field>
          <Field label="Y">{num('buildYmm')}</Field>
          <Field label="Z (height)">{num('buildZmm')}</Field>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Technical margins (mm)</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Each side, X and Y" hint="Skirt, brim, purge line, edge of the plate.">{num('marginXYmm')}</Field>
          <Field label="Top (Z)">{num('marginZmm')}</Field>
          <Field label="Extra each side when supports may be needed">{num('supportMarginXYmm')}</Field>
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Nozzle (mm)">{num('nozzleDiameterMm')}</Field>
        <Field label="Thinnest side (mm)" hint="Empty = the nozzle diameter. Thinner than this goes to manual review.">{num('minFeatureMm')}</Field>
        <Field label="Max supports (0 to 1)" hint="Empty = no limit.">{num('maxSupportRatio')}</Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Materials this machine can make</legend>
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">{materials.map((name) => check(machine.allowedMaterials.includes(name), name, () => toggle('allowedMaterials', name)))}</div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Finishes it offers</legend>
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">{finishes.map((name) => check(machine.allowedFinishes.includes(name), name, () => toggle('allowedFinishes', name)))}</div>
      </fieldset>

      <Field label="Notes"><textarea className="input mt-1 w-full" rows={2} maxLength={500} value={machine.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn min-h-11" onClick={save} disabled={saving} aria-busy={saving}>{saving ? 'Saving…' : isNew ? 'Add machine' : 'Save'}</button>
        {message ? <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-emerald-300' : 'text-red-300'} break-words`}>{message.text}</p> : null}
      </div>
    </section>
  )
}

export default function PrinterMachinesManager({ initial, materials, finishes }: { initial: Machine[]; materials: string[]; finishes: string[] }) {
  const [machines, setMachines] = useState<Machine[]>(initial)
  const [drafts, setDrafts] = useState<number[]>([])
  const [seq, setSeq] = useState(0)
  return (
    <div className="space-y-4">
      {machines.map((machine) => <Card key={machine.id} initial={machine} materials={materials} finishes={finishes} onSaved={() => undefined} />)}
      {drafts.map((id) => (
        <Card key={`draft-${id}`} initial={NEW_MACHINE} materials={materials} finishes={finishes}
          onSaved={(saved) => { setMachines((list) => [...list, saved]); setDrafts((list) => list.filter((entry) => entry !== id)) }} />
      ))}
      <button type="button" className="btn min-h-11" onClick={() => { setDrafts((list) => [...list, seq]); setSeq((n) => n + 1) }}>Add another machine</button>
    </div>
  )
}
