import type { NextRequest } from 'next/server'

export function sanitizeBaseUrl(raw?: string | null) {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    url.hash = ''
    url.search = ''
    const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '')
    return base || null
  } catch {
    const cleaned = trimmed.replace(/\/+$/, '')
    return cleaned || null
  }
}

// Base URL used to build links to our own files and API (BASE_URL, else the origin of the request).
export function resolvePublicBaseUrl(req: NextRequest) {
  return sanitizeBaseUrl(process.env.BASE_URL) || sanitizeBaseUrl(req.nextUrl?.origin || '')
}

// Base URL for the pages Stripe sends the customer back to. It comes from configuration ONLY in production: a forged Host
// header must never decide where a payment page redirects. (Outside production the request origin is accepted, for local work.)
export function resolveReturnBaseUrl(req: NextRequest): { url: string } | { error: string } {
  const configured = sanitizeBaseUrl(process.env.BASE_URL)
  if (process.env.NODE_ENV === 'production') {
    if (!configured) return { error: 'BASE_URL is not set' }
    if (!configured.startsWith('https://')) return { error: 'BASE_URL must start with https:// in production' }
    return { url: configured }
  }
  const url = configured || sanitizeBaseUrl(req.nextUrl?.origin || '')
  return url ? { url } : { error: 'BASE_URL is not set' }
}

// Base URL for the calls the server makes to ITS OWN API while pricing (colour palette). In production it comes from
// configuration only, so a forged Host header can never decide where the server connects to.
export function resolveInternalBaseUrl(req: NextRequest): string | null {
  const base = resolveReturnBaseUrl(req)
  return 'url' in base ? base.url : null
}
