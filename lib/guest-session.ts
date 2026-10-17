// The browser identity of a GUEST at checkout (step 4.6, S5): a signed cookie, issued before the payment, that says "this is the same browser as a moment ago".
//
// What it is FOR, and nothing else:
//   * the key a browser chooses to make "pay" safe to repeat is kept in that browser's own namespace on the server (lib/checkout-orders.ts, storedCheckoutKey),
//     so two people who happen to send the same key never reach each other's order;
//   * the server can tell that two requests come from the same browser even when they carry different keys, and so makes ONE order for ONE purchase attempt;
//   * request limits can count per browser as well as per address.
// What it is NOT: an authorization. It opens no order, no status page, no receipt, no file, no list. Those keep their own checks (the order's access cookie
// `mw_checkout`, the account, lib/file-access.ts). Only the two checkout routes that make a quote and open a payment read it (tests/security/guest-session.sec.ts
// keeps the list of files that may).
//
// Shape: `v1.<sid>.<issuedAt>.<mac>`. `sid` = 16 random bytes; `issuedAt` = seconds since 1970; `mac` = HMAC-SHA256 over the first three parts, with a key derived
// from JWT_SECRET under a label of its own: a value can only be made by this server, and is compared in constant time. The SERVER enforces the expiry from
// `issuedAt` (the browser's Max-Age is a courtesy): a copy kept for longer than 30 days is refused. Nothing is stored for a visitor who never orders (stateless);
// the database only ever sees the SHA-256 of `sid` (`PrintOrder.guestSessionHash`), never the `sid`.
//
// Its NAME depends on the connection (step 4.6, S5 closure, R7): over https it is `__Host-mw_sid` - a name the browser only accepts when it is `Secure`, `Path=/`, has
// no `Domain` and was set over https, so neither another site of the same domain nor a plain-http network can plant a session of its own in a customer's browser -
// and the server reads ONLY that name there (a perfectly valid `mw_sid` presented over https is a planted one and is ignored). Over plain http (development, a
// phone on the local network, the tests) the browser would refuse the prefixed name, so it stays `mw_sid`. Which of the two is decided by
// lib/guest-cookie-transport.ts, from the configuration and never from what a request says about itself.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'

// plain http (development, tests)
export const GUEST_SESSION_COOKIE = 'mw_sid'
// https (production)
export const GUEST_SESSION_COOKIE_HOST = '__Host-mw_sid'
export const GUEST_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
// A session in use is given a new `issuedAt` (same `sid`) when it is older than this, so one that is used keeps living and one that is not ends after 30 days.
export const GUEST_SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000
// A cookie that claims to have been made in the future (a clock that is off) is not believed beyond this.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const VERSION = 'v1'
const MAX_VALUE_LENGTH = 128
const SID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const ISSUED_PATTERN = /^\d{9,11}$/
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type GuestSession = {
  // the random part: it lives in the cookie, never in the database or in a log
  sid: string
  // SHA-256 of the sid: this is what an order stores and what a request limit is counted under
  hash: string
  issuedAt: Date
}
export type SealedGuestSession = { session: GuestSession; value: string }

function secret(): string {
  const value = process.env.JWT_SECRET
  if (!value || value.length < 32) throw new Error('JWT_SECRET is not set (or too short): cannot issue a guest session')
  return value
}

// The key that signs the cookie: derived, never the secret itself, so a value made for another purpose can not be mistaken for a session.
function macKey(): Buffer {
  return createHmac('sha256', secret()).update('mw:guest-session:mac-key:v1').digest()
}
function macOf(sid: string, issuedAtSeconds: number): string {
  return createHmac('sha256', macKey()).update(`${VERSION}.${sid}.${issuedAtSeconds}`).digest('base64url')
}

export function hashGuestSession(sid: string): string {
  return createHash('sha256').update(`mw:guest-session:hash:v1:${sid}`).digest('hex')
}

function seal(sid: string, now: Date): SealedGuestSession {
  const issuedAtSeconds = Math.floor(now.getTime() / 1000)
  return {
    session: { sid, hash: hashGuestSession(sid), issuedAt: new Date(issuedAtSeconds * 1000) },
    value: `${VERSION}.${sid}.${issuedAtSeconds}.${macOf(sid, issuedAtSeconds)}`,
  }
}

// A new session: a new identity.
export function mintGuestSession(now: Date = new Date()): SealedGuestSession {
  return seal(randomBytes(16).toString('base64url'), now)
}

// The same identity with a new `issuedAt`: the cookie of a browser that keeps coming back.
export function renewGuestSession(session: GuestSession, now: Date = new Date()): SealedGuestSession {
  return seal(session.sid, now)
}

export function guestSessionNeedsRenewal(session: GuestSession, now: Date = new Date()): boolean {
  return now.getTime() - session.issuedAt.getTime() >= GUEST_SESSION_RENEW_AFTER_MS
}

// The session in a cookie value, or null: absent, malformed, signed by somebody else, altered, expired, from the future. Never throws (when the server's secret
// is missing nothing can be verified, and "no valid session" is the safe answer).
export function verifyGuestSession(value: string | null | undefined, now: Date = new Date()): GuestSession | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LENGTH) return null
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) return null
  const [, sid, issuedText, mac] = parts
  if (!SID_PATTERN.test(sid) || !ISSUED_PATTERN.test(issuedText) || !MAC_PATTERN.test(mac)) return null
  const issuedAtSeconds = Number(issuedText)
  let expected: string
  try { expected = macOf(sid, issuedAtSeconds) } catch { return null }
  // compared as text, in constant time: the same bytes written another way (base64 allows several spellings of the last character) are not accepted
  const presented = Buffer.from(mac)
  const wanted = Buffer.from(expected)
  if (presented.length !== wanted.length || !timingSafeEqual(presented, wanted)) return null
  const issuedAt = issuedAtSeconds * 1000
  if (issuedAt > now.getTime() + MAX_FUTURE_SKEW_MS) return null
  if (now.getTime() - issuedAt >= GUEST_SESSION_TTL_MS) return null
  return { sid, hash: hashGuestSession(sid), issuedAt: new Date(issuedAt) }
}

// ---- the cookie ------------------------------------------------------------------------------------------------------------------
// Not readable by scripts (HttpOnly: the page never needs to know it), not sent along with requests made by other sites (Lax still lets the browser come back
// from the payment page with it), and `Secure` wherever the site is served over https. No `Domain` and `Path=/` always: that is what `__Host-` demands, and a
// cookie that is not meant to leave this host should say nothing else anyway.
export function guestSessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge: Math.floor(GUEST_SESSION_TTL_MS / 1000) }
}

// The name for the connection: `__Host-mw_sid` over https, `mw_sid` over plain http.
export function guestSessionCookieName(secure: boolean) {
  return secure ? GUEST_SESSION_COOKIE_HOST : GUEST_SESSION_COOKIE
}

type CookieTarget = { cookies: { set: (name: string, value: string, options: ReturnType<typeof guestSessionCookieOptions>) => unknown } }
export function setGuestSessionCookie(response: CookieTarget, sealed: SealedGuestSession, secure: boolean) {
  response.cookies.set(guestSessionCookieName(secure), sealed.value, guestSessionCookieOptions(secure))
}

// The cookie of the connection and no other: over https only `__Host-mw_sid`, over plain http only `mw_sid`. The other name is not "an older cookie to be
// accepted too" - over https it is the one a site that is not ours could have planted.
type CookieJar = { get: (name: string) => { value?: string } | undefined }
export function readGuestSessionCookie(jar: CookieJar, secure: boolean): string | undefined {
  return jar.get(guestSessionCookieName(secure))?.value
}

// What a guest's request needs, from the cookie it came with: the session to use, and the cookie to send back when there was none (a new identity) or it is old
// enough to be renewed. `fresh` is true only for a NEW identity.
export function planGuestSession(cookieValue: string | null | undefined, now: Date = new Date()): { session: GuestSession; send: SealedGuestSession | null; fresh: boolean } {
  const current = verifyGuestSession(cookieValue, now)
  if (current) return { session: current, send: guestSessionNeedsRenewal(current, now) ? renewGuestSession(current, now) : null, fresh: false }
  const minted = mintGuestSession(now)
  return { session: minted.session, send: minted, fresh: true }
}
