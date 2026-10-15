"use client"
// Asks the server what the cart costs, and keeps the answer honest while the cart changes.
//   * one request per distinct cart (same cart + delivery + rush = same signature): going back to a choice already asked about
//     within the last 30 seconds answers from memory;
//   * a newer request cancels the older one and an old answer can never replace a newer one (sequence counter);
//   * while a new answer is awaited the last good one can still be shown (dimmed) but is never `ready`: the caller pays only a quote
//     that belongs to the request on screen;
//   * a "too many requests" answer is retried once, after the pause the server asked for;
//   * coming back to the page through the browser's back button (page restored from memory) asks again.
// It never creates an order or a payment: the quote endpoint only calculates.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { quoteSignature, requestQuote, type CheckoutFailure, type QuoteRequest, type ServerQuote } from '@/lib/checkout-client'

const CACHE_TTL_MS = 30_000
const MAX_AUTO_RETRY_SECONDS = 60

export type QuoteState =
  | { phase: 'idle' }
  | { phase: 'loading'; stale: ServerQuote | null }
  | { phase: 'ready'; quote: ServerQuote; signature: string }
  | { phase: 'error'; failure: CheckoutFailure; stale: ServerQuote | null }

export function useServerQuote(request: QuoteRequest | null, options: { debounceMs?: number } = {}) {
  const debounceMs = options.debounceMs ?? 0
  const signature = useMemo(() => (request ? quoteSignature(request) : null), [request])
  const [state, setState] = useState<QuoteState>({ phase: 'idle' })
  const requestRef = useRef<QuoteRequest | null>(request)
  requestRef.current = request
  const signatureRef = useRef<string | null>(signature)
  signatureRef.current = signature
  const cache = useRef(new Map<string, { quote: ServerQuote; at: number }>())
  const lastGood = useRef<ServerQuote | null>(null)
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const run = useCallback(async (sig: string, req: QuoteRequest, canAutoRetry: boolean) => {
    const mine = ++sequence.current
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    try {
      const result = await requestQuote(req, abort.signal)
      if (mine !== sequence.current) return // a newer question has been asked since
      if (result.ok) {
        cache.current.set(sig, { quote: result.quote, at: Date.now() })
        lastGood.current = result.quote
        setState({ phase: 'ready', quote: result.quote, signature: sig })
        return
      }
      setState({ phase: 'error', failure: result.failure, stale: lastGood.current })
      if (canAutoRetry && result.failure.kind === 'busy') {
        const wait = Math.min(result.failure.retryAfterSeconds ?? 5, MAX_AUTO_RETRY_SECONDS) * 1000
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null
          if (signatureRef.current === sig && requestRef.current) {
            setState({ phase: 'loading', stale: lastGood.current })
            void run(sig, requestRef.current, false)
          }
        }, wait)
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      if (mine === sequence.current) setState({ phase: 'error', failure: { kind: 'unknown', code: 'CLIENT_ERROR', status: 0, retry: true }, stale: lastGood.current })
    }
  }, [])

  useEffect(() => {
    if (!signature || !requestRef.current) {
      sequence.current++
      controller.current?.abort()
      setState({ phase: 'idle' })
      return
    }
    const cached = cache.current.get(signature)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      sequence.current++
      controller.current?.abort()
      setState({ phase: 'ready', quote: cached.quote, signature })
      return
    }
    setState({ phase: 'loading', stale: lastGood.current })
    const timer = setTimeout(() => { if (requestRef.current) void run(signature, requestRef.current, true) }, debounceMs)
    return () => clearTimeout(timer)
  }, [signature, debounceMs, run])

  // leaving the page: nothing may answer into a page that is gone
  useEffect(() => () => {
    sequence.current++
    controller.current?.abort()
    if (retryTimer.current) clearTimeout(retryTimer.current)
  }, [])

  const refresh = useCallback(() => {
    const sig = signatureRef.current
    const req = requestRef.current
    if (!sig || !req) return
    cache.current.delete(sig)
    setState({ phase: 'loading', stale: lastGood.current })
    void run(sig, req, true)
  }, [run])

  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) refresh() }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [refresh])

  return { state, signature, refresh }
}
