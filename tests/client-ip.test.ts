// Step 4.2 – which address is believed for the request limits (lib/client-ip.ts). Pure logic, no database.
//
// Rule under test: a header the visitor can send by himself is never believed. Only what a proxy of OURS wrote is: the entry of
// X-Forwarded-For that many places from the END of the list as there are trusted proxies (TRUSTED_PROXY_HOPS), or a single-address
// header that the platform always overwrites (CLIENT_IP_HEADER). Nothing configured = "unknown".
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  UNKNOWN_IP, describeClientIpSource, getClientIpHeaderName, getTrustedProxyHops, normalizeAddress, rateLimitIdentity, resolveClientIp, resolveRateLimitIp,
} from '../lib/client-ip'

const h = (values: Record<string, string>) => new Headers(values)

test('nothing configured: no header is believed, whatever the visitor sends', () => {
  const env = {}
  const headers = h({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.8', 'cf-connecting-ip': '203.0.113.9' })
  assert.equal(resolveClientIp(headers, env), null)
  assert.equal(resolveRateLimitIp(headers, env), UNKNOWN_IP)
  assert.equal(describeClientIpSource(env).source, 'none')
})

test('one trusted proxy: the LAST entry is the client, entries the visitor put in front are ignored', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' }
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '198.51.100.99, 10.1.1.1, 203.0.113.7' }), env), '203.0.113.7')
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '203.0.113.7' }), env), '203.0.113.7')
  // The visitor can not become somebody else by writing the first entry, nor choose a new "address" for each request
  const first = resolveRateLimitIp(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }), env)
  const second = resolveRateLimitIp(h({ 'x-forwarded-for': '2.2.2.2, 203.0.113.7' }), env)
  assert.equal(first, second)
  assert.equal(first, '203.0.113.7')
})

test('two trusted proxies: the second from the end is the client', () => {
  const env = { TRUSTED_PROXY_HOPS: '2' }
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2' }), env), '203.0.113.7')
  // fewer entries than proxies: the request did not go through them all, nothing is believed
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '203.0.113.7' }), env), null)
})

test('X-Real-IP and other headers are not believed unless CLIENT_IP_HEADER names them', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' }
  assert.equal(resolveClientIp(h({ 'x-real-ip': '203.0.113.8' }), env), null)
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '6.6.6.6', 'cf-connecting-ip': '7.7.7.7' }), env), '203.0.113.7')
})

test('CLIENT_IP_HEADER: only that header, one address, no fallback to X-Forwarded-For', () => {
  const env = { CLIENT_IP_HEADER: 'CF-Connecting-IP', TRUSTED_PROXY_HOPS: '1' }
  assert.equal(getClientIpHeaderName(env), 'cf-connecting-ip')
  assert.equal(resolveClientIp(h({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6' }), env), '203.0.113.7')
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '6.6.6.6' }), env), null, 'configured header missing: not the visitor-controlled list')
  assert.equal(resolveClientIp(h({ 'cf-connecting-ip': '6.6.6.6, 203.0.113.7' }), env), null, 'a list is not a single address')
  assert.equal(resolveClientIp(h({ 'cf-connecting-ip': 'not-an-address' }), env), null)
  assert.equal(describeClientIpSource(env).source, 'header')
})

test('CLIENT_IP_HEADER can not name the forwarded list or be malformed', () => {
  assert.equal(getClientIpHeaderName({ CLIENT_IP_HEADER: 'x-forwarded-for' }), null)
  assert.equal(getClientIpHeaderName({ CLIENT_IP_HEADER: 'Forwarded' }), null)
  assert.equal(getClientIpHeaderName({ CLIENT_IP_HEADER: 'bad header' }), null)
  assert.equal(getClientIpHeaderName({ CLIENT_IP_HEADER: '' }), null)
  // x-forwarded-for named as the header falls back to the hop count, which is zero here
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '6.6.6.6' }), { CLIENT_IP_HEADER: 'x-forwarded-for' }), null)
})

test('TRUSTED_PROXY_HOPS: only a whole number counts, never negative or absurd', () => {
  for (const bad of ['', 'abc', '-1', '1.5', ' ', '0x2', '100', '1e1']) assert.equal(getTrustedProxyHops({ TRUSTED_PROXY_HOPS: bad }), 0, bad)
  assert.equal(getTrustedProxyHops({ TRUSTED_PROXY_HOPS: ' 2 ' }), 2)
  assert.equal(getTrustedProxyHops({ TRUSTED_PROXY_HOPS: '0' }), 0)
  assert.equal(getTrustedProxyHops({ TRUSTED_PROXY_HOPS: '10' }), 10)
})

test('what is not an address is not believed: names, garbage, oversized lists', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' }
  for (const bad of ['unknown', 'localhost', '999.1.1.1', "1.2.3.4'; DROP TABLE", '<script>', '1.2.3', '']) {
    assert.equal(resolveClientIp(h({ 'x-forwarded-for': `203.0.113.7, ${bad}` }), env), null, JSON.stringify(bad))
  }
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': `${'1.1.1.1, '.repeat(60)}203.0.113.7` }), env), null, 'too many entries')
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': `${'a'.repeat(2500)}, 203.0.113.7` }), env), null, 'too long')
})

test('ports and brackets some proxies add are removed; IPv4-mapped IPv6 is shown as IPv4', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' }
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '203.0.113.7:51234' }), env), '203.0.113.7')
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '[2001:db8::1]:443' }), env), '2001:db8::1')
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '::ffff:203.0.113.7' }), env), '203.0.113.7')
  assert.equal(resolveClientIp(h({ 'x-forwarded-for': '::FFFF:cb00:7107' }), env), '203.0.113.7')
  assert.equal(normalizeAddress('2001:db8::1'), '2001:db8::1')
})

test('IPv6: the /64 is counted, because one connection owns all 2^64 addresses of it', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' }
  const a = resolveRateLimitIp(h({ 'x-forwarded-for': '2001:db8:aa:bb:1111:2222:3333:4444' }), env)
  const b = resolveRateLimitIp(h({ 'x-forwarded-for': '2001:db8:aa:bb::9' }), env)
  const c = resolveRateLimitIp(h({ 'x-forwarded-for': '2001:db8:aa:bc::9' }), env)
  assert.equal(a, b, 'same /64, same counter')
  assert.notEqual(a, c, 'another /64 is another visitor')
  assert.equal(a, '2001:db8:aa:bb::/64')
  assert.equal(rateLimitIdentity('2001:db8::1'), '2001:db8:0:0::/64')
  assert.equal(rateLimitIdentity('::1'), '0:0:0:0::/64')
  assert.equal(rateLimitIdentity('203.0.113.7'), '203.0.113.7', 'IPv4 is counted per address')
})
