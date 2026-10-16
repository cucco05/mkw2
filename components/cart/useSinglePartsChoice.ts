"use client"
// The choice a customer has to make when the parts in the cart would make a complete model (lib/single-parts-ack.ts): shared by the cart page and the
// checkout page, so that "Pay" is off in both until the customer chooses - and so a choice made in one is seen by the other.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { cartItemsSignature, type ServerQuote } from '@/lib/checkout-client'
import { completeModelNotices, needsSinglePartsChoice, writeSinglePartsAck } from '@/lib/single-parts-ack'
import { persistentStore } from '@/components/checkout/usePendingOrder'
import type { CartItem } from '@/components/cart/CartProvider'

export function useSinglePartsChoice(items: CartItem[], quote: ServerQuote | null) {
  const signature = useMemo(() => (items.length > 0 ? cartItemsSignature(items) : null), [items])
  // bound to what the ITEMS cost (after discounts, before delivery and tax): the cart and the checkout may differ in delivery, and that is not a price change of the goods
  const totalCents = quote ? quote.itemsTotalCents : null
  // bumped when this tab confirms, or when another tab does (the memory is in localStorage like the cart)
  const [version, setVersion] = useState(0)
  const [memoryAck, setMemoryAck] = useState<{ signature: string; totalCents: number } | null>(null)
  useEffect(() => {
    const onStorage = () => setVersion((value) => value + 1)
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const notices = useMemo(() => completeModelNotices(quote?.unitNotices), [quote])
  const mustChoose = useMemo(
    () => (quote ? needsSinglePartsChoice(quote.unitNotices, persistentStore(), signature, totalCents, memoryAck) : false),
    // `version` makes the check read the storage again after a confirmation
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quote, signature, totalCents, memoryAck, version],
  )
  const confirmSingleParts = useCallback(() => {
    if (!signature || totalCents == null) return
    writeSinglePartsAck(persistentStore(), signature, totalCents)
    setMemoryAck({ signature, totalCents })
    setVersion((value) => value + 1)
  }, [signature, totalCents])
  return { notices, mustChoose, confirmSingleParts }
}
