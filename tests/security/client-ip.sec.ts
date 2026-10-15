// S2/S3 step 4.2 – the client address behind the request limits can not be chosen by the visitor.
//
// Before: the FIRST entry of X-Forwarded-For was believed, so a visitor could send a different "address" with every request and
// never meet a per-address limit (unlimited password guesses per account, unlimited quotes and checkout sessions per address).
// Now: only what the proxy of ours wrote counts (the last entry with TRUSTED_PROXY_HOPS=1, set by the harness), and when no address
// can be told the limits that do not depend on it (whole shop, per order, per user) still apply.
// Fake data, throw-away database.
import { db, resetDb, seedShopModel } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'

let modelId = ''
let seq = 0
const spoof = () => `198.51.${Math.floor(++seq / 250)}.${seq % 250}` // a fresh made-up "address" for every request
const REAL_A = '203.0.113.10'
const REAL_B = '203.0.113.11'
const ENV_KEYS = ['TRUSTED_PROXY_HOPS', 'CLIENT_IP_HEADER', 'CHECKOUT_QUOTE_RATE_MAX', 'CHECKOUT_SESSION_RATE_MAX', 'CHECKOUT_GLOBAL_RATE_MAX', 'CHECKOUT_STATUS_RATE_MAX', 'CHECKOUT_STATUS_GLOBAL_RATE_MAX', 'CURRENCY', 'NEXT_PUBLIC_CURRENCY', 'SHIPPING_FLAT_RATE_CENTS'] as const
const saved: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) saved[key] = process.env[key]
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
}
async function fresh(env: Parameters<typeof setEnv>[0] = {}) {
  await (await db()).rateLimit.deleteMany()
  setEnv({
    TRUSTED_PROXY_HOPS: '1', CLIENT_IP_HEADER: undefined, CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700',
    CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000',
    CHECKOUT_STATUS_RATE_MAX: undefined, CHECKOUT_STATUS_GLOBAL_RATE_MAX: undefined, ...env,
  })
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel()).model.id
})
test.after(() => setEnv(saved))

// The proxy appends the address it saw to the list; the visitor can write whatever he likes BEFORE it.
const xff = (real: string | null) => (real ? `${spoof()}, ${real}` : spoof())

async function login(real: string | null, email = 'nobody@sectest.invalid') {
  const { POST } = await import('../../app/api/login/route')
  const res = (await (POST as any)(new NextRequest('http://localhost/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff(real) }, body: JSON.stringify({ email, password: 'wrong-password' }),
  }), {})) as Response
  return res.status
}
async function quote(real: string | null, extraHeaders: Record<string, string> = {}) {
  viewerGuards.getViewer = async () => null
  const { POST } = await import('../../app/api/checkout/quote/route')
  const res = (await (POST as any)(new NextRequest('http://localhost/api/checkout/quote', {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': xff(real), ...extraHeaders },
    body: JSON.stringify({ items: [{ modelId, qty: 1, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' }, rush: false }),
  }), {})) as Response
  return res.status
}
async function status(real: string | null, orderId: string) {
  viewerGuards.getViewer = async () => null
  const { GET } = await import('../../app/api/checkout/status/route')
  const res = (await (GET as any)(new NextRequest(`http://localhost/api/checkout/status?order=${orderId}`, { headers: { 'x-forwarded-for': xff(real) } }), {})) as Response
  return res.status
}
async function firstBlocked(call: () => Promise<number>, max = 12) {
  for (let i = 1; i <= max; i++) if ((await call()) === 429) return i
  return null
}

// ====================================================================================================================================
// the visitor can not pick a fresh counter by writing the first entry
// ====================================================================================================================================
test('login: guessing one account is stopped even when every request carries a different forged first address', async () => {
  await fresh()
  const stoppedAt = await firstBlocked(() => login(REAL_A))
  assert.ok(stoppedAt !== null && stoppedAt <= 8, `blocked at request ${stoppedAt}: five tries are allowed, then the account waits`)
  // other people are not affected: another real address, another account
  assert.equal(await login(REAL_B), 401)
  assert.equal(await login(REAL_A, 'someone-else@sectest.invalid'), 401)
})

test('login: with no trusted source the forged headers still buy nothing (one shared counter for the account)', async () => {
  await fresh({ TRUSTED_PROXY_HOPS: undefined })
  const stoppedAt = await firstBlocked(() => login(null, 'nobody2@sectest.invalid'))
  assert.ok(stoppedAt !== null && stoppedAt <= 8, `blocked at request ${stoppedAt}`)
  // and nothing was filed under any forged address
  const keys = (await (await db()).rateLimit.findMany({ where: { key: { startsWith: 'login:' } } })).map((r) => r.key)
  assert.deepEqual(keys, ['login:nobody2@sectest.invalid:unknown'])
})

test('checkout quote: the per-address limit holds against a forged first address, and is per real address', async () => {
  await fresh({ CHECKOUT_QUOTE_RATE_MAX: '3' })
  const results: number[] = []
  for (let i = 0; i < 5; i++) results.push(await quote(REAL_A))
  assert.deepEqual(results, [200, 200, 200, 429, 429])
  assert.equal(await quote(REAL_B), 200, 'another real address still has its own budget')
})

test('checkout quote: X-Real-IP / Forwarded / CF headers sent by the visitor are not believed either', async () => {
  await fresh({ CHECKOUT_QUOTE_RATE_MAX: '2' })
  const results: number[] = []
  for (let i = 0; i < 4; i++) results.push(await quote(REAL_A, { 'x-real-ip': spoof(), 'cf-connecting-ip': spoof(), forwarded: `for=${spoof()}` }))
  assert.deepEqual(results, [200, 200, 429, 429])
})

test('checkout quote: CLIENT_IP_HEADER takes the address from that header only', async () => {
  await fresh({ TRUSTED_PROXY_HOPS: undefined, CLIENT_IP_HEADER: 'x-real-ip', CHECKOUT_QUOTE_RATE_MAX: '2' })
  const results: number[] = []
  for (let i = 0; i < 4; i++) results.push(await quote(null, { 'x-real-ip': REAL_A }))
  assert.deepEqual(results, [200, 200, 429, 429])
  assert.equal(await quote(null, { 'x-real-ip': REAL_B }), 200)
  // a visitor who rotates X-Forwarded-For but goes through the proxy that sets X-Real-IP stays at one counter
  const rotated: number[] = []
  for (let i = 0; i < 3; i++) rotated.push(await quote(REAL_B, { 'x-real-ip': REAL_B }))
  assert.deepEqual(rotated, [200, 429, 429])
})

// ====================================================================================================================================
// the limits that do not depend on the address survive when it can not be told
// ====================================================================================================================================
test('no trusted address: the whole-shop limit still stops quotes, and no shared "unknown" per-address counter is created', async () => {
  await fresh({ TRUSTED_PROXY_HOPS: undefined, CHECKOUT_GLOBAL_RATE_MAX: '3' })
  const results: number[] = []
  for (let i = 0; i < 5; i++) results.push(await quote(null))
  assert.deepEqual(results, [200, 200, 200, 429, 429])
  const keys = (await (await db()).rateLimit.findMany({ where: { key: { startsWith: 'checkout:' } } })).map((r) => r.key).sort()
  assert.deepEqual(keys, ['checkout:quote:all'])
})

test('no trusted address: a misconfigured proxy does not make the per-address budget shared (it would lock out everybody at 120)', async () => {
  await fresh({ TRUSTED_PROXY_HOPS: undefined, CHECKOUT_QUOTE_RATE_MAX: '2', CHECKOUT_GLOBAL_RATE_MAX: '1000' })
  for (let i = 0; i < 6; i++) assert.equal(await quote(null), 200)
})

test('order status: the per-order limit applies whatever address is claimed, with and without a trusted address', async () => {
  const orderId = 'clxxxxxxxxxxxxxxxxxxxxxxx'
  await fresh({ CHECKOUT_STATUS_RATE_MAX: '3' })
  const withProxy: number[] = []
  for (let i = 0; i < 6; i++) withProxy.push(await status(`203.0.113.${100 + i}`, orderId)) // six different REAL addresses
  assert.deepEqual(withProxy.map((s) => s === 429), [false, false, false, true, true, true])
  await fresh({ TRUSTED_PROXY_HOPS: undefined, CHECKOUT_STATUS_RATE_MAX: '3' })
  const without: number[] = []
  for (let i = 0; i < 6; i++) without.push(await status(null, orderId))
  assert.deepEqual(without.map((s) => s === 429), [false, false, false, true, true, true])
})

test('order status: the whole-shop limit applies without a trusted address', async () => {
  await fresh({ TRUSTED_PROXY_HOPS: undefined, CHECKOUT_STATUS_GLOBAL_RATE_MAX: '3' })
  const results: number[] = []
  for (let i = 0; i < 6; i++) results.push(await status(null, `clyyyyyyyyyyyyyyyyyyyyy${i}`)) // a different order every time
  assert.deepEqual(results.map((s) => s === 429), [false, false, false, true, true, true])
})

// ====================================================================================================================================
// the audit trail and the login telemetry store the believed address, not the claimed one
// ====================================================================================================================================
test('admin audit: the stored address is the proxy-written one, null when none can be told', async () => {
  const { getAdminAuditRequestMeta } = await import('../../lib/admin-audit')
  const request = () => new Request('http://localhost/api/admin/x', { method: 'POST', headers: { 'x-forwarded-for': `6.6.6.6, ${REAL_A}`, 'x-real-ip': '7.7.7.7' } })
  await fresh()
  assert.equal(getAdminAuditRequestMeta(request()).requestIp, REAL_A)
  await fresh({ TRUSTED_PROXY_HOPS: undefined })
  assert.equal(getAdminAuditRequestMeta(request()).requestIp, null)
})

test('the admin environment check fails in production until a client address source is configured', async () => {
  const { buildEnvChecks } = await import('../../app/api/admin/env-check/route')
  const base = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'a-valid-test-jwt-secret-with-32-chars', NODE_ENV: 'production', TAX_MODE: 'none' }
  const find = (env: Record<string, string>) => buildEnvChecks(env).find((c) => c.key === 'TRUSTED_PROXY_HOPS')
  assert.equal(find(base)?.ok, false)
  assert.equal(find(base)?.required, true)
  assert.equal(find({ ...base, TRUSTED_PROXY_HOPS: '1' })?.ok, true)
  assert.equal(find({ ...base, CLIENT_IP_HEADER: 'cf-connecting-ip' })?.ok, true)
  assert.equal(find({ ...base, TRUSTED_PROXY_HOPS: '0' })?.ok, false, 'zero proxies is the same as nothing')
  assert.equal(find({ ...base, NODE_ENV: 'development' }), undefined, 'not demanded outside production')
})
