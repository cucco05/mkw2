// The browser harness of tests/e2e/checkout-faults.responsive.spec.ts (R1-2 / S-11): the REAL components/checkout/HostedCheckout.tsx inside the REAL CartProvider, mounted by the REAL React 19 in a
// real browser. Bundled by tests/e2e/_checkout-harness-build.ts. It decides nothing: the assertions are in the spec.
//
// What is real: the component, the cart provider, the notice of a pending payment, the quote hook, lib/checkout-client.ts, lib/checkout-single-flight.ts (unless the build is the "lost answer" one),
// the browser's storage, fetch, AbortController and Web Locks. What is not: the site around the page (no server, no CSS, no router - `next/link` is an anchor), the answers of /api/checkout/*
// (stubbed by the spec, like in the other specs of R1-2), and the browser's way to LEAVE the page: `window.location.assign` is replaced at build time by `__mwAssign`, which records the address
// instead of going there (or throws, when the spec says so) - a harness page that really left would be gone before it could be looked at.
import React, { StrictMode, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import CartProvider, { useCart } from '@/components/cart/CartProvider'
import HostedCheckout from '@/components/checkout/HostedCheckout'

type Handle = {
  mount: (options: { strict: boolean; cart?: unknown; signedIn?: boolean }) => void
  unmount: () => void
  mounted: () => boolean
  addItem: (n: number) => void
}

declare global {
  interface Window {
    __checkout: Handle
    __mwAssign: (url: string) => void
    __redirect: { mode: 'ok' | 'throw'; urls: string[] }
  }
}

const CART_KEY = 'mwv2:cart'
let root: Root | null = null
let latest: ReturnType<typeof useCart> | null = null

window.__redirect = { mode: 'ok', urls: [] }
window.__mwAssign = (url: string) => {
  if (window.__redirect.mode === 'throw') throw new DOMException('Navigation is not allowed from here.', 'SecurityError')
  window.__redirect.urls.push(url)
}

function Probe() {
  const cart = useCart()
  useLayoutEffect(() => { latest = cart })
  return null
}

window.__checkout = {
  mount: ({ strict, cart, signedIn }) => {
    if (cart !== undefined) localStorage.setItem(CART_KEY, JSON.stringify(cart))
    const tree = (
      <CartProvider>
        <Probe />
        <HostedCheckout signedIn={Boolean(signedIn)} canceled={false} showBillingLink={false} contactEmail="aiuto@example.test" />
      </CartProvider>
    )
    root = createRoot(document.getElementById('root')!)
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  },
  unmount: () => { root?.unmount(); root = null; latest = null },
  mounted: () => root !== null,
  // another line in the cart: what a customer does in another tab, or on this page, while a request is on its way
  addItem: (n) => {
    latest!.add({ modelId: `clmodelmodelmodel9${String(n).padStart(5, '0')}`, title: `Added ${n}`, priceUsd: 5, thumbnail: null, size: { x: 10, y: 10, z: 10 }, colorSlotCount: 1, allowedColors: null }, { qty: 1, material: 'PLA', colors: ['#ffffff'] })
  },
}
