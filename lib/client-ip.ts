// Which address did this request come from? Only what a proxy WE operate has written is believed.
//
// Why: `X-Forwarded-For` (and `X-Real-IP`) are plain request headers. Anyone can send them, so reading the FIRST entry of
// `X-Forwarded-For` (as this app did until Step 4.2) lets a client pick its own "address" for every rate limit. A proxy appends
// the address it saw to the END of the list, so only the entries on the right were written by our own infrastructure.
//
// Configuration (both optional; with neither, no header is believed and the address is "unknown"):
//   CLIENT_IP_HEADER    a header that the platform in front of the app always overwrites with the real client address and
//                       that holds one address, e.g. cf-connecting-ip (Cloudflare), fly-client-ip (Fly.io) or x-real-ip when the
//                       proxy sets it from $remote_addr. When it is set, it is the only source (no fallback to the other one).
//   TRUSTED_PROXY_HOPS  how many proxies of ours sit in front of the app and append to X-Forwarded-For (1 = one reverse proxy).
//                       The client is the entry that many places from the END of the list. 0 / unset = X-Forwarded-For is ignored.
//
// "unknown" is a legitimate answer: the callers keep their IP-independent limits (whole shop, per order, per user), so an address
// that cannot be told never lifts a limit. The admin environment check reports it so it cannot go unnoticed in production.
import { isIP } from 'node:net'

export const UNKNOWN_IP = 'unknown'

const MAX_HEADER_LENGTH = 2000
const MAX_FORWARDED_ENTRIES = 40
const MAX_TRUSTED_HOPS = 10

type HeaderReader = { get(name: string): string | null }
type Env = Record<string, string | undefined>

export function getTrustedProxyHops(env: Env = process.env): number {
  const raw = (env.TRUSTED_PROXY_HOPS || '').trim()
  if (!/^\d{1,2}$/.test(raw)) return 0
  return Math.min(Number.parseInt(raw, 10), MAX_TRUSTED_HOPS)
}

export function getClientIpHeaderName(env: Env = process.env): string | null {
  const raw = (env.CLIENT_IP_HEADER || '').trim().toLowerCase()
  // A header name only. `x-forwarded-for` is a LIST that clients can prepend to: it is configured with TRUSTED_PROXY_HOPS instead.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw) || raw === 'x-forwarded-for' || raw === 'forwarded') return null
  return raw
}

// Is anything configured that makes the address believable? (Used by the admin environment check.)
export function describeClientIpSource(env: Env = process.env): { source: 'header' | 'proxy-hops' | 'none'; detail: string } {
  const header = getClientIpHeaderName(env)
  if (header) return { source: 'header', detail: `the ${header} header` }
  const hops = getTrustedProxyHops(env)
  if (hops > 0) return { source: 'proxy-hops', detail: `X-Forwarded-For, entry ${hops} from the end` }
  return { source: 'none', detail: 'no trusted source: every request counts as "unknown"' }
}

// One address in textual form, or null. Accepts "1.2.3.4", "1.2.3.4:5678", "::1", "[::1]:443", "fe80::1%eth0".
function parseAddress(value: string): string | null {
  let text = value.trim()
  if (!text || text.length > 64) return null
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text)
  if (bracketed) text = bracketed[1]
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(':'))
  text = text.split('%')[0]
  return isIP(text) ? text.toLowerCase() : null
}

// The 8 sixteen-bit groups of an IPv6 address (isIP has already vouched for the text).
function ipv6Groups(address: string): number[] | null {
  let text = address
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number)
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length
    if (missing < 1) return null
    groups = [...head, ...Array(missing).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => Number.parseInt(g, 16))
}

// The address as it is stored in logs and audit trails: validated, lower case, IPv4-mapped IPv6 shown as plain IPv4.
export function normalizeAddress(address: string): string {
  if (isIP(address) !== 6) return address
  const groups = ipv6Groups(address)
  if (groups && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`
  }
  return address
}

// The address as it is counted by a rate limit. A home or mobile connection owns a whole /64 of IPv6 addresses and can switch
// between them at will, so counting single IPv6 addresses would be no limit at all: the /64 is the unit.
export function rateLimitIdentity(address: string): string {
  const normal = normalizeAddress(address)
  if (isIP(normal) !== 6) return normal
  const groups = ipv6Groups(normal)
  if (!groups) return normal
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`
}

// The client address a trusted proxy wrote into the request, or null. Never a value the client alone could have chosen
// (unless the deployment itself lets clients write the configured header: that is what CLIENT_IP_HEADER must never be).
export function resolveClientIp(headers: HeaderReader, env: Env = process.env): string | null {
  const headerName = getClientIpHeaderName(env)
  if (headerName) {
    const value = headers.get(headerName)
    if (!value || value.length > MAX_HEADER_LENGTH || value.includes(',')) return null
    const address = parseAddress(value)
    return address ? normalizeAddress(address) : null
  }
  const hops = getTrustedProxyHops(env)
  if (hops < 1) return null
  const forwarded = headers.get('x-forwarded-for')
  if (!forwarded || forwarded.length > MAX_HEADER_LENGTH) return null
  const entries = forwarded.split(',')
  if (entries.length > MAX_FORWARDED_ENTRIES || entries.length < hops) return null
  const address = parseAddress(entries[entries.length - hops])
  return address ? normalizeAddress(address) : null
}

// What the rate limits use: a stable text, or "unknown".
export function resolveRateLimitIp(headers: HeaderReader, env: Env = process.env): string {
  const address = resolveClientIp(headers, env)
  return address ? rateLimitIdentity(address) : UNKNOWN_IP
}
