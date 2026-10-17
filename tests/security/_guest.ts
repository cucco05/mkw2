// A guest's BROWSER, for the tests (step 4.6, S5): the signed session cookie that the checkout routes ask a guest to carry (lib/guest-session.ts).
//
// Before S5 a guest could pay with nothing but a key; now a request without a valid `mw_sid` is answered 428 and creates nothing. The tests that are about prices,
// limits or the payment pages are not about that, so their helpers send the cookie of THE test browser (one per test file, made on first use). A test that is
// about WHO is paying makes browsers of its own (`newGuestBrowser()`) and passes them on.
// Import this after './_harness' (which sets JWT_SECRET).
import { GUEST_SESSION_COOKIE, mintGuestSession } from '../../lib/guest-session'

export type GuestBrowser = { cookie: string; value: string; sid: string; hash: string }

export function newGuestBrowser(now: Date = new Date()): GuestBrowser {
  const sealed = mintGuestSession(now)
  return { cookie: `${GUEST_SESSION_COOKIE}=${sealed.value}`, value: sealed.value, sid: sealed.session.sid, hash: sealed.session.hash }
}

let shared: GuestBrowser | null = null
export const testBrowser = (): GuestBrowser => (shared ??= newGuestBrowser())

// The headers of a request made by `browser`: whatever the test gave (its own `cookie` header is kept, after the session) plus the session cookie.
export function guestHeaders(extra: Record<string, string> = {}, browser: GuestBrowser = testBrowser()): Record<string, string> {
  return { ...extra, cookie: [browser.cookie, extra.cookie].filter(Boolean).join('; ') }
}
