// Limited access for a guest (no account) to the status of THEIR OWN order after paying.
//
// What the token is: a long unguessable value, derived from a server secret and the order id (HMAC-SHA256), handed to the buyer
// in an HttpOnly cookie. The database stores only its SHA-256 hash and an expiry date, never the token.
// Why derived instead of random: the same order always yields the same token, so two simultaneous or repeated requests (double
// click, retry after a lost response) cannot overwrite each other's token and leave the browser holding one that no longer matches.
//
// What the token allows: reading the status page of that one order (order number, state, total) - nothing else. It is NOT a login:
// it does not unlock files, receipts, addresses, other orders or any API; those keep their own authorization (lib/file-access.ts,
// getOrderForUser). Orders that belong to an account are never reachable with a token.
import { createHash, createHmac, timingSafeEqual } from 'crypto'

export const GUEST_ACCESS_COOKIE = 'mw_checkout'
export const GUEST_ACCESS_TTL_MS = 72 * 60 * 60 * 1000

export type GuestAccessFields = {
  userId: string | null
  guestAccessTokenHash: string | null
  guestAccessExpiresAt: Date | null
}

function secret(): string {
  const value = process.env.JWT_SECRET
  if (!value || value.length < 32) throw new Error('JWT_SECRET is not set (or too short): cannot issue guest order access')
  return value
}

export function deriveGuestAccessToken(orderId: string): string {
  return createHmac('sha256', secret()).update(`mw:guest-order-access:v1:${orderId}`).digest('base64url')
}

export function hashGuestAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Values to store on a guest order when it is created.
export function issueGuestAccess(orderId: string, now: Date = new Date()) {
  const token = deriveGuestAccessToken(orderId)
  return {
    token,
    hash: hashGuestAccessToken(token),
    expiresAt: new Date(now.getTime() + GUEST_ACCESS_TTL_MS),
  }
}

export function verifyGuestAccess(order: GuestAccessFields, token: string | null | undefined, now: Date = new Date()): boolean {
  if (order.userId) return false // an order that belongs to an account is only reachable through that account
  if (!token || typeof token !== 'string' || token.length > 200) return false
  if (!order.guestAccessTokenHash || !order.guestAccessExpiresAt) return false
  if (order.guestAccessExpiresAt.getTime() <= now.getTime()) return false
  const presented = Buffer.from(hashGuestAccessToken(token), 'hex')
  const stored = Buffer.from(order.guestAccessTokenHash, 'hex')
  return presented.length === stored.length && timingSafeEqual(presented, stored)
}

// ---- the cookie: a short list, so a second order does not make the first one unreachable --------------------------------------
// Value: "orderId.token~orderId.token~..." (newest first, at most GUEST_COOKIE_MAX_ORDERS). The browser sends it back and the
// server only uses it to LOOK UP the token for the order being asked about; every token is still checked against the hash and the
// expiry stored on that order, so a forged or stale entry opens nothing.
export const GUEST_COOKIE_MAX_ORDERS = 5

export type GuestAccessEntry = { orderId: string; token: string }

export function buildGuestAccessCookieValue(orderId: string, token: string): string {
  return `${orderId}.${token}`
}

function parseEntry(value: string): GuestAccessEntry | null {
  const dot = value.indexOf('.')
  if (dot <= 0 || dot === value.length - 1) return null
  const orderId = value.slice(0, dot)
  const token = value.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(orderId) || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null
  return { orderId, token }
}

export function parseGuestAccessCookieList(value: string | null | undefined): GuestAccessEntry[] {
  if (!value || value.length > 1500) return []
  const seen = new Set<string>()
  const entries: GuestAccessEntry[] = []
  for (const part of value.split('~')) {
    const entry = parseEntry(part)
    if (!entry || seen.has(entry.orderId)) continue
    seen.add(entry.orderId)
    entries.push(entry)
    if (entries.length >= GUEST_COOKIE_MAX_ORDERS) break
  }
  return entries
}

// The cookie value to send back after this order was created or asked for again: this order first, the others kept.
export function mergeGuestAccessCookie(existing: string | null | undefined, orderId: string, token: string): string {
  const others = parseGuestAccessCookieList(existing).filter((entry) => entry.orderId !== orderId)
  return [{ orderId, token }, ...others]
    .slice(0, GUEST_COOKIE_MAX_ORDERS)
    .map((entry) => buildGuestAccessCookieValue(entry.orderId, entry.token))
    .join('~')
}

export function findGuestToken(value: string | null | undefined, orderId: string): string | null {
  return parseGuestAccessCookieList(value).find((entry) => entry.orderId === orderId)?.token ?? null
}

// A single entry (kept for callers that handle one order).
export function parseGuestAccessCookie(value: string | null | undefined): GuestAccessEntry | null {
  return value && value.length <= 300 && !value.includes('~') ? parseEntry(value) : null
}
