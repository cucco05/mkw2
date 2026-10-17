// Step 4.6 (S5) – the signed cookie of a guest's browser (lib/guest-session.ts): what it is made of, what is refused, and how long it lives.
// Pure rules, no database, no network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  GUEST_SESSION_COOKIE, GUEST_SESSION_COOKIE_HOST, GUEST_SESSION_RENEW_AFTER_MS, GUEST_SESSION_TTL_MS, guestSessionCookieName, guestSessionCookieOptions,
  guestSessionNeedsRenewal, hashGuestSession, mintGuestSession, planGuestSession, readGuestSessionCookie, renewGuestSession, setGuestSessionCookie, verifyGuestSession,
} from '../lib/guest-session'
import { deriveGuestAccessToken } from '../lib/guest-order-access'

const SECRET = 'unit-test-jwt-secret-0123456789abcdefghij'
process.env.JWT_SECRET = process.env.JWT_SECRET || SECRET
const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-10-17T10:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

function withSecret<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.JWT_SECRET
  if (value === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = value
  try { return fn() } finally { process.env.JWT_SECRET = saved }
}

test('a new session verifies, carries 128 random bits, and the database would only ever see a hash of them', () => {
  const { session, value } = mintGuestSession(T0)
  assert.match(value, /^v1\.[A-Za-z0-9_-]{22}\.\d{10}\.[A-Za-z0-9_-]{43}$/)
  assert.equal(GUEST_SESSION_COOKIE, 'mw_sid')
  const back = verifyGuestSession(value, T0)
  assert.ok(back)
  assert.equal(back!.sid, session.sid)
  assert.equal(back!.hash, session.hash)
  assert.equal(back!.issuedAt.getTime(), Math.floor(T0.getTime() / 1000) * 1000)
  assert.equal(session.sid.length, 22)
  // the hash is a SHA-256 of the sid under a label, never the sid itself, and the sid can not be read from it
  assert.equal(session.hash, createHash('sha256').update(`mw:guest-session:hash:v1:${session.sid}`).digest('hex'))
  assert.match(session.hash, /^[0-9a-f]{64}$/)
  assert.ok(!session.hash.includes(session.sid))
  assert.equal(hashGuestSession(session.sid), session.hash)
  assert.notEqual(hashGuestSession(session.sid), createHash('sha256').update(session.sid).digest('hex'), 'the label is part of the hash')
  // nothing in the value needs quoting or escaping in a cookie
  assert.match(value, /^[A-Za-z0-9._-]+$/)
})

test('every new session is a different identity', () => {
  const sids = new Set<string>()
  const hashes = new Set<string>()
  for (let i = 0; i < 2000; i++) {
    const { session } = mintGuestSession(T0)
    sids.add(session.sid)
    hashes.add(session.hash)
  }
  assert.equal(sids.size, 2000)
  assert.equal(hashes.size, 2000)
})

test('absent, empty, malformed and oversized values are no session (and never throw)', () => {
  const good = mintGuestSession(T0).value
  for (const bad of [undefined, null, '', ' ', 'v1', 'v1...', 'v1.a.b.c', `${good}.extra`, good.slice(0, -1), good.slice(1), `x${good.slice(1)}`, 'v2' + good.slice(2), good.replace(/\./g, '-'), `${good}${'a'.repeat(200)}`, 'a'.repeat(5000)]) {
    assert.equal(verifyGuestSession(bad as any, T0), null, String(bad).slice(0, 60))
  }
  for (const notText of [123, {}, [], true]) assert.equal(verifyGuestSession(notText as any, T0), null)
})

test('a forged or altered value is refused: another sid, another date, another or truncated signature, a signature taken from another session', () => {
  const a = mintGuestSession(T0)
  const b = mintGuestSession(T0)
  const [version, sid, issued, mac] = a.value.split('.')
  const flip = (text: string, index: number) => text.slice(0, index) + (text[index] === 'A' ? 'B' : 'A') + text.slice(index + 1)
  const forged = [
    [version, flip(sid, 0), issued, mac],                               // another identity, same signature
    [version, flip(sid, 21), issued, mac],
    [version, sid, String(Number(issued) + 1), mac],                    // a later date to live longer
    [version, sid, String(Number(issued) - 1), mac],
    [version, sid, issued, flip(mac, 0)],
    [version, sid, issued, flip(mac, 20)],
    [version, sid, issued, mac.slice(0, 42)],
    [version, sid, issued, `${mac}A`],
    [version, sid, issued, b.value.split('.')[3]],                      // the signature of another session
    [version, b.session.sid, issued, mac],                              // the identity of another session with this signature
    [version, sid, issued, 'A'.repeat(43)],
    [version, sid, issued, '-'.repeat(43)],
  ]
  for (const parts of forged) assert.equal(verifyGuestSession(parts.join('.'), T0), null, parts.join('.'))
  assert.ok(verifyGuestSession(a.value, T0), 'the untouched value is fine')
})

test('the same signature written another way is not accepted (base64 has several spellings of its last character)', () => {
  const { value } = mintGuestSession(T0)
  const [version, sid, issued, mac] = value.split('.')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = mac[mac.length - 1]
  // 43 characters hold 258 bits for 256 bits of signature: the last one carries 4 significant bits and 2 spare ones, so characters that differ only in the
  // spare bits decode to the very same bytes
  const cousins = [...alphabet].filter((c) => c !== last && Math.floor(alphabet.indexOf(c) / 4) === Math.floor(alphabet.indexOf(last) / 4))
  assert.equal(cousins.length, 3)
  for (const c of cousins) {
    assert.deepEqual(Buffer.from(mac.slice(0, -1) + c, 'base64url'), Buffer.from(mac, 'base64url'), 'same bytes')
    assert.equal(verifyGuestSession([version, sid, issued, mac.slice(0, -1) + c].join('.'), T0), null, `spelling ${c}`)
  }
})

test('a value signed with another secret is refused; with no secret nothing verifies (and nothing throws), and nothing can be issued', () => {
  const { value } = mintGuestSession(T0)
  assert.ok(verifyGuestSession(value, T0))
  withSecret('another-secret-0123456789abcdefghijklmnop', () => {
    assert.equal(verifyGuestSession(value, T0), null)
    const theirs = mintGuestSession(T0).value
    assert.ok(verifyGuestSession(theirs, T0))
    withSecret(SECRET, () => assert.equal(verifyGuestSession(theirs, T0), null))
  })
  withSecret(undefined, () => {
    assert.equal(verifyGuestSession(value, T0), null)
    assert.throws(() => mintGuestSession(T0), /JWT_SECRET/)
  })
  withSecret('short', () => {
    assert.equal(verifyGuestSession(value, T0), null)
    assert.throws(() => mintGuestSession(T0), /JWT_SECRET/)
  })
})

test('it is not interchangeable with the order access token (own key, own label)', () => {
  const token = deriveGuestAccessToken('cmorderA0000000000000001')
  assert.equal(verifyGuestSession(token, T0), null)
  assert.equal(verifyGuestSession(`v1.${token.slice(0, 22)}.1790000000.${token.slice(0, 43)}`, T0), null)
})

test('the session ends 30 days after it was issued, by the server\'s own count; one from the future is believed only within a small clock error', () => {
  const { value } = mintGuestSession(T0)
  assert.ok(verifyGuestSession(value, at(0)))
  assert.ok(verifyGuestSession(value, at(30 * DAY - 2000)), 'still valid one second before the end')
  assert.equal(verifyGuestSession(value, at(30 * DAY)), null, 'expired')
  assert.equal(verifyGuestSession(value, at(31 * DAY)), null)
  assert.equal(verifyGuestSession(value, at(400 * DAY)), null)
  assert.equal(GUEST_SESSION_TTL_MS, 30 * DAY)
  // made "in the future": a clock a few minutes off is fine, an hour ahead is not
  assert.ok(verifyGuestSession(value, at(-4 * 60 * 1000)))
  assert.equal(verifyGuestSession(value, at(-60 * 60 * 1000)), null)
})

test('a session in use is renewed (same identity, new date) once it is a day old; a young one is left alone', () => {
  const first = mintGuestSession(T0)
  assert.equal(guestSessionNeedsRenewal(first.session, at(0)), false)
  assert.equal(guestSessionNeedsRenewal(first.session, at(GUEST_SESSION_RENEW_AFTER_MS - 1000)), false)
  assert.equal(guestSessionNeedsRenewal(first.session, at(GUEST_SESSION_RENEW_AFTER_MS)), true)
  const later = at(20 * DAY)
  const renewed = renewGuestSession(first.session, later)
  assert.equal(renewed.session.sid, first.session.sid)
  assert.equal(renewed.session.hash, first.session.hash, 'the identity does not change when the cookie is renewed')
  assert.notEqual(renewed.value, first.value)
  const back = verifyGuestSession(renewed.value, at(45 * DAY))
  assert.ok(back, 'the renewed cookie lives 30 days from the renewal')
  assert.equal(back!.hash, first.session.hash)
  assert.equal(verifyGuestSession(first.value, at(45 * DAY)), null, 'the old value ended on its own date')
  assert.equal(verifyGuestSession(renewed.value, at(50 * DAY + 1000)), null)
})

test('planning a request: no cookie or a bad one = a NEW identity to send; a good one = the same identity; an old one = the same identity, renewed', () => {
  const nothing = planGuestSession(undefined, T0)
  assert.equal(nothing.fresh, true)
  assert.ok(nothing.send)
  assert.equal(verifyGuestSession(nothing.send!.value, T0)!.hash, nothing.session.hash)

  const forged = mintGuestSession(T0).value.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
  const replaced = planGuestSession(forged, T0)
  assert.equal(replaced.fresh, true, 'a forged cookie counts for nothing')
  assert.ok(replaced.send)
  assert.notEqual(replaced.session.sid, forged.split('.')[1], 'and its identity is not adopted')

  const expired = mintGuestSession(T0).value
  assert.equal(planGuestSession(expired, at(31 * DAY)).fresh, true)

  const mine = mintGuestSession(T0)
  const same = planGuestSession(mine.value, at(1000))
  assert.equal(same.fresh, false)
  assert.equal(same.send, null, 'nothing to send for a young session')
  assert.equal(same.session.hash, mine.session.hash)

  const old = planGuestSession(mine.value, at(2 * DAY))
  assert.equal(old.fresh, false)
  assert.ok(old.send, 'an old session is renewed')
  assert.equal(old.send!.session.hash, mine.session.hash)
  assert.equal(old.session.hash, mine.session.hash)
})

test('the cookie is HttpOnly, SameSite=Lax, Path=/, lives 30 days, and is Secure wherever the site is served over https', () => {
  for (const secure of [true, false]) {
    assert.deepEqual(guestSessionCookieOptions(secure), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 30 * 24 * 60 * 60 })
  }
  const sets: Array<[string, string, Record<string, unknown>]> = []
  const sealed = mintGuestSession(T0)
  const target = { cookies: { set: (name: string, value: string, options: Record<string, unknown>) => { sets.push([name, value, options]) } } }
  setGuestSessionCookie(target, sealed, true)
  setGuestSessionCookie(target, sealed, false)
  assert.deepEqual(sets, [
    ['__Host-mw_sid', sealed.value, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 2592000 }],
    ['mw_sid', sealed.value, { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 2592000 }],
  ])
})

test('the name depends on the connection: __Host-mw_sid over https, mw_sid over plain http (the browser would refuse the prefixed name there)', () => {
  assert.equal(GUEST_SESSION_COOKIE, 'mw_sid')
  assert.equal(GUEST_SESSION_COOKIE_HOST, '__Host-mw_sid')
  assert.equal(guestSessionCookieName(true), '__Host-mw_sid')
  assert.equal(guestSessionCookieName(false), 'mw_sid')
})

test('what __Host- demands is what is set: Secure, Path=/, and NO Domain - on every cookie this server sends under that name', () => {
  const options = guestSessionCookieOptions(true) as Record<string, unknown>
  assert.equal(options.secure, true)
  assert.equal(options.path, '/')
  assert.ok(!('domain' in options), 'no Domain key at all: a Domain would make the browser refuse the cookie')
  assert.equal(options.httpOnly, true)
  assert.equal(options.sameSite, 'lax')
  // a renewed cookie is set the same way
  const sets: Array<[string, Record<string, unknown>]> = []
  const first = mintGuestSession(T0)
  setGuestSessionCookie({ cookies: { set: (name: string, _value: string, o: Record<string, unknown>) => { sets.push([name, o]) } } }, renewGuestSession(first.session, at(2 * DAY)), true)
  assert.equal(sets[0][0], '__Host-mw_sid')
  assert.ok(!('domain' in sets[0][1]))
})

test('only the cookie of the connection is read: over https a perfectly valid mw_sid is a planted one and counts for nothing; over plain http a __Host- one does not', () => {
  const sealed = mintGuestSession(T0)
  const jarOf = (cookies: Record<string, string>) => ({ get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) })
  const plain = jarOf({ mw_sid: sealed.value })
  const host = jarOf({ '__Host-mw_sid': sealed.value })
  const both = jarOf({ mw_sid: mintGuestSession(T0).value, '__Host-mw_sid': sealed.value })
  assert.equal(readGuestSessionCookie(host, true), sealed.value)
  assert.equal(readGuestSessionCookie(plain, true), undefined, 'https: the unprefixed name is not read')
  assert.equal(readGuestSessionCookie(plain, false), sealed.value)
  assert.equal(readGuestSessionCookie(host, false), undefined, 'plain http: the prefixed name is not read')
  assert.equal(readGuestSessionCookie(jarOf({}), true), undefined)
  // with both present the one of the connection wins, whatever the order
  assert.equal(readGuestSessionCookie(both, true), sealed.value)
  assert.notEqual(readGuestSessionCookie(both, false), sealed.value)
  // and what is read is checked like any other value
  assert.equal(verifyGuestSession(readGuestSessionCookie(plain, true), T0), null)
  assert.ok(verifyGuestSession(readGuestSessionCookie(host, true), T0))
})
