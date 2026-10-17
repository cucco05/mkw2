// Over which kind of connection is a GUEST's cookie being handled - and may the guest check out at all? (step 4.6, S5 closure, R7)
//
// The guest session cookie is `__Host-mw_sid` over https and `mw_sid` over plain http (lib/guest-session.ts). Deciding which, from what a request says about itself,
// would hand the choice to whoever writes the request: `X-Forwarded-Proto` and `Forwarded` are plain headers, a proxy that APPENDS to them (instead of replacing them)
// leaves the client's own words in front, and the weaker name is the one a site that is not ours can plant. So:
//
//   * PRODUCTION (`NODE_ENV=production`): the answer is `secure`, always. It comes from the configuration - this is production, and production is https
//     (resolveReturnBaseUrl does not let a payment page be opened without an https BASE_URL) - and no header can lower it: not a forged one, not a conflicting
//     one, and not `COOKIE_SECURE=false`, which keeps its meaning for the other cookies but is not read for this one. The headers can only say NO: when
//     TRUSTED_PROXY_HOPS says a proxy of ours sits in front of the app and the entry that proxy wrote (counted from the END of the list, like the client address,
//     lib/client-ip.ts) says `http`, the connection is not the https one production is meant to have, and the guest does not check out (`refuse`): better a refused
//     checkout, loud in the logs, than a payment started over a connection that is not what it should be. A value that is missing or that nobody understands is no
//     veto - and it never opens the door to the weaker name either.
//   * ANYTHING ELSE (development, tests, a phone on the local network, a local container): exactly what it has always been, `shouldUseSecureCookies()` -
//     the forwarded protocol, then COOKIE_SECURE, then BASE_URL. Nothing changes there.
//
// The decision is made before the cookie is read, from the request's headers (the route has them), never from the cookie. Customers with an account do not use
// this cookie and do not call this.
import { shouldUseSecureCookies } from '@/lib/auth'
import { getTrustedProxyHops } from '@/lib/client-ip'

type HeaderReader = { get(name: string): string | null }
type Env = Record<string, string | undefined>

export type GuestCookieTransport =
  | { mode: 'secure' } // https: `__Host-mw_sid`, Secure
  | { mode: 'plain' } // plain http (not production): `mw_sid`
  | { mode: 'refuse'; reason: 'insecure_transport' } // production, and the proxy of ours says the connection is plain http: no guest checkout

const MAX_HEADER_LENGTH = 2000
const MAX_ENTRIES = 40

// "http", "https" or nothing: lower case, no quotes, no spaces; any other word is not a claim about the protocol.
function protoOf(value: string | undefined): 'http' | 'https' | null {
  const word = (value ?? '').trim().replace(/^"|"$/g, '').trim().toLowerCase()
  if (word === 'https') return 'https'
  if (word === 'http') return 'http'
  return null
}

// The entry written by the proxy of ours that is CLOSEST to the app: `hops` places from the END of the list. A list shorter than that has lost entries on the way:
// the first one left is then the outermost claim there is.
function trustedEntry(entries: string[], hops: number): string | undefined {
  return entries[Math.max(0, entries.length - hops)]
}

// What the proxy(ies) of ours say about the protocol the customer used, or null. `hops` < 1 (no proxy of ours is declared): the headers are not read at all.
// `X-Forwarded-Proto` and `Forwarded: proto=` are both read at the same place; if either says "http" the answer is "http" (a conflict is not settled in favour of https).
export function trustedProtoClaim(headers: HeaderReader, hops: number): 'http' | 'https' | null {
  if (!Number.isInteger(hops) || hops < 1) return null
  const claims: Array<'http' | 'https' | null> = []
  const forwardedProto = headers.get('x-forwarded-proto')
  if (forwardedProto && forwardedProto.length <= MAX_HEADER_LENGTH) {
    const entries = forwardedProto.split(',')
    if (entries.length <= MAX_ENTRIES) claims.push(protoOf(trustedEntry(entries, hops)))
  }
  const forwarded = headers.get('forwarded')
  if (forwarded && forwarded.length <= MAX_HEADER_LENGTH) {
    const entries = forwarded.split(',')
    if (entries.length <= MAX_ENTRIES) {
      const match = /(?:^|;)\s*proto\s*=\s*("?)([^;",\s]*)\1/i.exec(trustedEntry(entries, hops) ?? '')
      claims.push(protoOf(match?.[2]))
    }
  }
  if (claims.includes('http')) return 'http'
  if (claims.includes('https')) return 'https'
  return null
}

export async function resolveGuestCookieTransport(headers: HeaderReader, env: Env = process.env): Promise<GuestCookieTransport> {
  if (env.NODE_ENV === 'production') {
    return trustedProtoClaim(headers, getTrustedProxyHops(env)) === 'http' ? { mode: 'refuse', reason: 'insecure_transport' } : { mode: 'secure' }
  }
  return (await shouldUseSecureCookies()) ? { mode: 'secure' } : { mode: 'plain' }
}
