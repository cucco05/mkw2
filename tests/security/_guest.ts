// A guest's BROWSER, for the tests (step 4.6, S5): the signed session cookie that the checkout routes ask a guest to carry (lib/guest-session.ts).
//
// Before S5 a guest could pay with nothing but a key; now a request without a valid `mw_sid` is answered 428 and creates nothing. The tests that are about prices,
// limits or the payment pages are not about that, so their helpers send the cookie of THE test browser (one per test file, made on first use). A test that is
// about WHO is paying makes browsers of its own (`newGuestBrowser()`) and passes them on.
// Import this after './_harness' (which sets JWT_SECRET).
import { GUEST_SESSION_COOKIE, GUEST_SESSION_COOKIE_HOST, mintGuestSession } from '../../lib/guest-session'

export type GuestBrowser = { cookie: string; value: string; sid: string; hash: string }

export function newGuestBrowser(now: Date = new Date()): GuestBrowser {
  const sealed = mintGuestSession(now)
  return { cookie: `${GUEST_SESSION_COOKIE}=${sealed.value}`, value: sealed.value, sid: sealed.session.sid, hash: sealed.session.hash }
}

let shared: GuestBrowser | null = null
export const testBrowser = (): GuestBrowser => (shared ??= newGuestBrowser())

// The headers of a request made by `browser`: whatever the test gave (its own `cookie` header is kept, after the session) plus the session cookie.
// In production mode the server reads `__Host-mw_sid` and no other name (lib/guest-cookie-transport.ts, step 4.6 S5 closure): a test that switches NODE_ENV to
// production (the production guards of s2s3-step2) is a browser talking to an https site, so it sends the same session under that name. The tests ABOUT the names
// (guest-session.sec.ts) make their own cookies and do not come through here.
export function guestHeaders(extra: Record<string, string> = {}, browser: GuestBrowser = testBrowser()): Record<string, string> {
  const session = process.env.NODE_ENV === 'production' ? `${GUEST_SESSION_COOKIE_HOST}=${browser.value}` : browser.cookie
  return { ...extra, cookie: [session, extra.cookie].filter(Boolean).join('; ') }
}
