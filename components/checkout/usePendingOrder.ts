"use client"
// The order this browser sent to the payment page for the cart now in front of the customer, if any (lib/order-status-client.ts keeps the memory in
// localStorage, so every tab sees the same one). It follows the memory: another tab that settles the order, or this one, makes it go away.
import { useEffect, useState } from 'react'
import { PENDING_ORDERS_EVENT, pendingOrderForCart, type PendingOrder } from '@/lib/order-status-client'

export function persistentStore(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}

export function usePendingOrder(cartSignature: string | null): PendingOrder | null {
  const [entry, setEntry] = useState<PendingOrder | null>(null)
  useEffect(() => {
    const read = () => {
      const next = pendingOrderForCart(persistentStore(), cartSignature)
      setEntry((current) => (current?.orderId === next?.orderId && current?.cartSignature === next?.cartSignature ? current : next))
    }
    read()
    // `storage` fires in the OTHER tabs when this memory changes; the event of our own is for this tab; `pageshow` for a page restored by the back button
    window.addEventListener('storage', read)
    window.addEventListener(PENDING_ORDERS_EVENT, read)
    window.addEventListener('pageshow', read)
    return () => {
      window.removeEventListener('storage', read)
      window.removeEventListener(PENDING_ORDERS_EVENT, read)
      window.removeEventListener('pageshow', read)
    }
  }, [cartSignature])
  return entry
}
