// Step 4.6 (S5 closure, R7) – over which kind of connection the guest session cookie is handled (lib/guest-cookie-transport.ts), and what a request can NOT do about it.
// Pure rules, no database, no network: the environment is passed in, the headers are made here.
//
//   * production: the answer is always "secure" (the name `__Host-mw_sid`); X-Forwarded-Proto and Forwarded can never lower it, whatever they say and however they are
//     forged; the only thing they can do is veto - when a proxy of OURS (TRUSTED_PROXY_HOPS, counted from the END of the list like the client address) says "http";
//   * anything else: exactly what shouldUseSecureCookies() has always said.
import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldUseSecureCookies } from '../lib/auth'
import { resolveGuestCookieTransport, trustedProtoClaim } from '../lib/guest-cookie-transport'

const headersOf = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null })
const xfp = (value: string) => headersOf({ 'x-forwarded-proto': value })
const fwd = (value: string) => headersOf({ forwarded: value })
const PROD = { NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '1' }

test('no proxy of ours declared (TRUSTED_PROXY_HOPS 0 or unset): the headers are not read at all', () => {
  for (const hops of [0, -1, 0.5, Number.NaN]) {
    assert.equal(trustedProtoClaim(xfp('http'), hops), null)
    assert.equal(trustedProtoClaim(xfp('https'), hops), null)
    assert.equal(trustedProtoClaim(fwd('proto=http'), hops), null)
  }
})

test('one proxy: its own word about the protocol, in any spelling; a word nobody understands is no claim', () => {
  assert.equal(trustedProtoClaim(xfp('https'), 1), 'https')
  assert.equal(trustedProtoClaim(xfp('http'), 1), 'http')
  assert.equal(trustedProtoClaim(xfp(' HTTPS '), 1), 'https')
  assert.equal(trustedProtoClaim(xfp('"http"'), 1), 'http')
  for (const nonsense of ['ftp', 'ws', '', ' ', 'htt', 'https://', 'null', ',']) assert.equal(trustedProtoClaim(xfp(nonsense), 1), null, JSON.stringify(nonsense))
  assert.equal(trustedProtoClaim(headersOf({}), 1), null)
})

test('a list is read from the END: what a client wrote in front of what the proxy wrote does not count', () => {
  assert.equal(trustedProtoClaim(xfp('http, https'), 1), 'https', 'forged "http" in front, the proxy appended https: not a veto')
  assert.equal(trustedProtoClaim(xfp('https, http'), 1), 'http', 'forged "https" in front, the proxy appended http: the connection IS plain http')
  assert.equal(trustedProtoClaim(xfp('https,https,http'), 1), 'http')
  assert.equal(trustedProtoClaim(xfp('http,http,https'), 1), 'https')
})

test('two proxies of ours: the entry of the outermost one, counted from the end; a list that is too short gives the first entry it has', () => {
  assert.equal(trustedProtoClaim(xfp('https, http'), 2), 'https', 'the edge proxy saw https, the inner one saw http from the edge')
  assert.equal(trustedProtoClaim(xfp('http, https, http'), 2), 'https', 'an extra entry in front is a client\'s')
  assert.equal(trustedProtoClaim(xfp('http'), 2), 'http', 'fewer entries than proxies: the first there is')
  assert.equal(trustedProtoClaim(xfp('https'), 2), 'https')
  assert.equal(trustedProtoClaim(xfp('x, y, https'), 2), null, 'the entry at that place is "y": nobody understands it')
})

test('the Forwarded header is read the same way (proto=, quoted or not, from the end of the list)', () => {
  assert.equal(trustedProtoClaim(fwd('for=203.0.113.9;proto=https'), 1), 'https')
  assert.equal(trustedProtoClaim(fwd('for=203.0.113.9;proto=http;by=10.0.0.1'), 1), 'http')
  assert.equal(trustedProtoClaim(fwd('for=203.0.113.9;PROTO="https"'), 1), 'https')
  assert.equal(trustedProtoClaim(fwd('proto=http, proto=https'), 1), 'https')
  assert.equal(trustedProtoClaim(fwd('proto=https, proto=http'), 1), 'http')
  assert.equal(trustedProtoClaim(fwd('proto=https, proto=http'), 2), 'https')
  assert.equal(trustedProtoClaim(fwd('for=203.0.113.9'), 1), null, 'no proto: no claim')
  assert.equal(trustedProtoClaim(fwd('proto=gopher'), 1), null)
})

test('two headers that disagree are settled AGAINST the https side: if either says http, the answer is http', () => {
  assert.equal(trustedProtoClaim(headersOf({ 'x-forwarded-proto': 'https', forwarded: 'proto=http' }), 1), 'http')
  assert.equal(trustedProtoClaim(headersOf({ 'x-forwarded-proto': 'http', forwarded: 'proto=https' }), 1), 'http')
  assert.equal(trustedProtoClaim(headersOf({ 'x-forwarded-proto': 'https', forwarded: 'proto=https' }), 1), 'https')
  assert.equal(trustedProtoClaim(headersOf({ 'x-forwarded-proto': 'nonsense', forwarded: 'proto=https' }), 1), 'https')
})

test('headers that are absurdly long or have absurdly many entries are not read as a claim (and open nothing)', () => {
  assert.equal(trustedProtoClaim(xfp(`${'https,'.repeat(450)}http`), 1), null, 'longer than 2000 characters')
  assert.equal(trustedProtoClaim(xfp(`${'a,'.repeat(45)}http`), 1), null, 'more than 40 entries')
  assert.equal(trustedProtoClaim(fwd(`${'proto=https,'.repeat(300)}proto=http`), 1), null)
  // the two limits are independent: a header that is too LONG with only a few entries (the count limit does not catch it) ...
  assert.equal(trustedProtoClaim(xfp(`${'x'.repeat(2100)},http`), 1), null, 'two entries, one of them 2100 characters')
  assert.equal(trustedProtoClaim(fwd(`for=${'x'.repeat(2100)},proto=http`), 1), null)
  // ... and one that is short enough with too MANY entries (the length limit does not catch it)
  assert.equal(trustedProtoClaim(fwd(`${'a,'.repeat(45)}proto=http`), 1), null)
  // right at the limits it is still read
  assert.equal(trustedProtoClaim(xfp(`${'x'.repeat(1990)},http`), 1), 'http')
  assert.equal(trustedProtoClaim(xfp(`${'a,'.repeat(38)}http`), 1), 'http', '39 entries')
})

test('PRODUCTION: always "secure" - no header, forged or not, lowers it (without a proxy of ours the headers are not even read)', async () => {
  const withoutProxy = { NODE_ENV: 'production' }
  for (const headers of [headersOf({}), xfp('http'), xfp('https'), fwd('proto=http'), xfp('http, http, http'), headersOf({ 'x-forwarded-proto': 'http', forwarded: 'proto=http' })]) {
    assert.deepEqual(await resolveGuestCookieTransport(headers, withoutProxy), { mode: 'secure' })
    assert.deepEqual(await resolveGuestCookieTransport(headers, { ...withoutProxy, TRUSTED_PROXY_HOPS: '0' }), { mode: 'secure' })
  }
  // never the plain mode, whatever is in the headers, whatever the number of proxies
  for (const hops of ['0', '1', '2', '3', 'x', '']) {
    for (const value of ['http', 'https', 'http, https', 'https, http', 'nonsense', '']) {
      const answer = await resolveGuestCookieTransport(xfp(value), { NODE_ENV: 'production', TRUSTED_PROXY_HOPS: hops })
      assert.notEqual(answer.mode, 'plain', `hops ${JSON.stringify(hops)} / ${JSON.stringify(value)}`)
    }
  }
})

test('PRODUCTION with a proxy of ours: https or no word = secure; "http" at the place of the proxy, or any conflict, = the guest does not check out', async () => {
  assert.deepEqual(await resolveGuestCookieTransport(xfp('https'), PROD), { mode: 'secure' })
  assert.deepEqual(await resolveGuestCookieTransport(headersOf({}), PROD), { mode: 'secure' })
  assert.deepEqual(await resolveGuestCookieTransport(xfp('nonsense'), PROD), { mode: 'secure' })
  assert.deepEqual(await resolveGuestCookieTransport(xfp('http, https'), PROD), { mode: 'secure' }, 'a forged http in front of the proxy\'s own https does not stop anybody')
  assert.deepEqual(await resolveGuestCookieTransport(xfp('http'), PROD), { mode: 'refuse', reason: 'insecure_transport' })
  assert.deepEqual(await resolveGuestCookieTransport(xfp('https, http'), PROD), { mode: 'refuse', reason: 'insecure_transport' })
  assert.deepEqual(await resolveGuestCookieTransport(fwd('for=1.2.3.4;proto=http'), PROD), { mode: 'refuse', reason: 'insecure_transport' })
  assert.deepEqual(await resolveGuestCookieTransport(headersOf({ 'x-forwarded-proto': 'https', forwarded: 'proto=http' }), PROD), { mode: 'refuse', reason: 'insecure_transport' })
  // two proxies of ours
  assert.deepEqual(await resolveGuestCookieTransport(xfp('https, http'), { ...PROD, TRUSTED_PROXY_HOPS: '2' }), { mode: 'secure' })
  assert.deepEqual(await resolveGuestCookieTransport(xfp('http'), { ...PROD, TRUSTED_PROXY_HOPS: '2' }), { mode: 'refuse', reason: 'insecure_transport' })
})

test('PRODUCTION ignores COOKIE_SECURE=false for this cookie (it keeps its meaning for the others): not even the operator\'s file lowers it', async () => {
  for (const cookieSecure of ['false', 'FALSE', 'true', '', undefined]) {
    assert.deepEqual(await resolveGuestCookieTransport(xfp('https'), { ...PROD, COOKIE_SECURE: cookieSecure }), { mode: 'secure' }, String(cookieSecure))
    assert.deepEqual(await resolveGuestCookieTransport(xfp('http'), { ...PROD, COOKIE_SECURE: cookieSecure }), { mode: 'refuse', reason: 'insecure_transport' }, String(cookieSecure))
  }
})

test('OUTSIDE production nothing is refused and the answer is the one shouldUseSecureCookies() has always given (development over http is untouched)', async () => {
  const saved = { cookieSecure: process.env.COOKIE_SECURE, baseUrl: process.env.BASE_URL }
  try {
    for (const cookieSecure of ['true', 'false', undefined]) {
      for (const baseUrl of ['https://shop.example.test', 'http://localhost:3000', undefined]) {
        if (cookieSecure === undefined) delete process.env.COOKIE_SECURE
        else process.env.COOKIE_SECURE = cookieSecure
        if (baseUrl === undefined) delete process.env.BASE_URL
        else process.env.BASE_URL = baseUrl
        const expected = (await shouldUseSecureCookies()) ? 'secure' : 'plain'
        for (const nodeEnv of ['development', 'test', undefined]) {
          // headers that would be a veto in production change nothing here
          for (const headers of [headersOf({}), xfp('http'), fwd('proto=http'), xfp('https')]) {
            const answer = await resolveGuestCookieTransport(headers, { NODE_ENV: nodeEnv, TRUSTED_PROXY_HOPS: '1' })
            assert.equal(answer.mode, expected, `${nodeEnv} / COOKIE_SECURE=${cookieSecure} / BASE_URL=${baseUrl}`)
          }
        }
      }
    }
  } finally {
    if (saved.cookieSecure === undefined) delete process.env.COOKIE_SECURE
    else process.env.COOKIE_SECURE = saved.cookieSecure
    if (saved.baseUrl === undefined) delete process.env.BASE_URL
    else process.env.BASE_URL = saved.baseUrl
  }
})
