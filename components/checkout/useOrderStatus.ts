"use client"
// Asks the server what became of an order and keeps asking only as long as it makes sense (step 4.3):
//   * the first question is asked at once (the customer has just come back from the payment page: `return=1`);
//   * while the payment is being confirmed it asks again after a growing pause, and gives up on its own after about two minutes
//     (then only a person pressing "check again" asks); a final answer (paid / under review / closed) or "not paid" stops it at once;
//   * nothing is asked while the tab is hidden; when the tab comes back it asks once, straight away;
//   * a newer question cancels the older one and an old answer can never replace a newer one; leaving the page cancels everything.
// It never decides anything: what it returns is the server's answer, as received.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublicOrderStatus } from '@/lib/checkout-status'
import { fetchOrderStatus, nextPollDelayMs, shouldKeepAsking } from '@/lib/order-status-client'

export type OrderStatusState =
  | { phase: 'loading' }
  | { phase: 'ready'; status: PublicOrderStatus; asking: boolean; gaveUp: boolean }
  | { phase: 'not_found' }
  | { phase: 'error'; retrying: boolean }   // no usable answer yet; `retrying`: the page will ask again by itself

export function useOrderStatus(orderId: string | null, fetcher: typeof fetch = fetch) {
  const [state, setState] = useState<OrderStatusState>({ phase: 'loading' })
  const asked = useRef(0)                 // how many repeats have been scheduled since the last manual refresh
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const last = useRef<PublicOrderStatus | null>(null)
  const waiting = useRef(false)           // a repeat is due (so a tab coming back should ask)
  const idRef = useRef(orderId)
  idRef.current = orderId

  const stopTimer = useCallback(() => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }, [])
  // leaving the page, or another order: nothing may answer into a page that is gone
  const cancelAll = useCallback(() => { sequence.current += 1; controller.current?.abort(); stopTimer() }, [stopTimer])

  const run = useCallback(async () => {
    const id = idRef.current
    if (!id) { setState({ phase: 'not_found' }); return }
    stopTimer()
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const mine = ++sequence.current
    setState((current) => (current.phase === 'ready' ? { ...current, asking: true } : current.phase === 'error' ? { ...current, retrying: true } : current))

    let result
    try {
      result = await fetchOrderStatus(id, { returned: true }, abort.signal, fetcher)
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      result = { kind: 'error' as const }
    }
    if (mine !== sequence.current) return // a newer question has been asked since

    const schedule = (hintMs: number | null, minimumMs = 0): boolean => {
      const delay = nextPollDelayMs(asked.current, hintMs)
      if (delay === null) { waiting.current = false; return false }
      asked.current += 1
      waiting.current = true
      stopTimer()
      timer.current = setTimeout(() => { timer.current = null; if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void run(); else waiting.current = true }, Math.max(delay, minimumMs))
      return true
    }

    if (result.kind === 'status') {
      last.current = result.status
      const again = shouldKeepAsking(result.status) && schedule(result.status.pollAfterMs)
      waiting.current = again
      setState({ phase: 'ready', status: result.status, asking: false, gaveUp: shouldKeepAsking(result.status) && !again })
      return
    }
    if (result.kind === 'not_found') {
      waiting.current = false
      setState({ phase: 'not_found' })
      return
    }
    // too many questions, or no usable answer: keep what we knew (if anything) and try again later, within the same limit
    const again = schedule(null, result.kind === 'busy' ? result.retryAfterSeconds * 1000 : 0)
    if (last.current) setState({ phase: 'ready', status: last.current, asking: false, gaveUp: !again })
    else setState({ phase: 'error', retrying: again })
  }, [fetcher, stopTimer])

  // first question
  useEffect(() => {
    asked.current = 0
    last.current = null
    void run()
    return () => cancelAll()
  }, [orderId, run, cancelAll])

  // nothing is asked in a hidden tab; coming back asks once, at once
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'hidden') { stopTimer(); return }
      if (waiting.current) void run()
    }
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) { asked.current = 0; void run() } }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onShow)
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', onShow) }
  }, [run, stopTimer])

  // "check again": a person asks, so the count starts over
  const checkAgain = useCallback(() => { asked.current = 0; void run() }, [run])

  return { state, checkAgain }
}
