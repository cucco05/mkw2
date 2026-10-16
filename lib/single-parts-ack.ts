// Step 4.6 - a cart made of parts of one model that TOGETHER make a complete model, but are not grouped as one.
//
// Before 4.6 a cart like that was priced with a provisional rule; now every part bought on its own is a unit of its own, and a complete model is a unit of
// its own, so the same cart can cost MORE as loose parts. The server never groups lines on its own (that would be the old rule again) - it says it
// (`COULD_BE_COMPLETE_MODEL`) and the customer decides: group them as a complete model, or confirm they want the parts one by one at the total shown.
// The confirmation is for THAT cart and THAT subtotal of the items only (delivery and tax may differ between the cart and the checkout, the price of the goods does not): any change to the cart, or to what the items cost, asks again. Pure functions, tested in node.
import type { UnitNotice } from '@/lib/sale-units'

const KEY = 'mw:single-parts-ack:v1'
type Store = Pick<Storage, 'getItem' | 'setItem'>

export type CompleteModelNotice = Extract<UnitNotice, { code: 'COULD_BE_COMPLETE_MODEL' }>

export function completeModelNotices(notices: ReadonlyArray<{ code: string }> | null | undefined): CompleteModelNotice[] {
  return (notices ?? []).filter((notice): notice is CompleteModelNotice => notice.code === 'COULD_BE_COMPLETE_MODEL')
}

export function readSinglePartsAck(store: Store | null, signature: string, totalCents: number): boolean {
  try {
    const raw = store?.getItem(KEY)
    if (!raw) return false
    const saved = JSON.parse(raw) as { signature?: unknown; totalCents?: unknown }
    return saved.signature === signature && saved.totalCents === totalCents
  } catch {
    return false
  }
}

export function writeSinglePartsAck(store: Store | null, signature: string, totalCents: number): void {
  try { store?.setItem(KEY, JSON.stringify({ signature, totalCents })) } catch { /* storage blocked: the confirmation lives in memory for this page only */ }
}

export function clearSinglePartsAck(store: Store | null): void {
  try { store?.setItem(KEY, '') } catch { /* nothing to forget */ }
}

// Whether the customer still has to choose before paying: the server suggests a complete model and this exact cart/total was not confirmed as single parts.
export function needsSinglePartsChoice(
  notices: ReadonlyArray<{ code: string }> | null | undefined,
  store: Store | null,
  signature: string | null,
  totalCents: number | null,
  inMemoryAck: { signature: string; totalCents: number } | null = null,
): boolean {
  if (completeModelNotices(notices).length === 0) return false
  if (!signature || totalCents == null) return true
  if (inMemoryAck && inMemoryAck.signature === signature && inMemoryAck.totalCents === totalCents) return false
  return !readSinglePartsAck(store, signature, totalCents)
}
