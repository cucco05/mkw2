// Step 4.6 (S5) – how long the hash of a guest's browser session stays on an order, and what the retention job may NOT empty.
//
//   * the hash is emptied 45 days after the order was made (DATA_RETENTION_GUEST_SESSION_DAYS) - longer than the 30-day life of the cookie itself;
//   * NOT on an order whose payment is in doubt (being confirmed, or arrived and waits for a person): there the hash is what lets the server recognise the
//     same browser and refuse a second payment of the same cart, with no time limit - an operational marker of the order's safety, not retention material;
//   * ONLY that column changes: not the metadata, not the review reason, not the payment markers, not the access token, not the checkout key - and not
//     `updatedAt`, which customers see;
//   * a dry run counts and changes nothing; the per-session request counters (named by the hash) go with it, the others stay;
//   * accounts are untouched: their orders never carried a hash, and lib/privacy.ts (account deletion) has nothing to do with it.
// Fake data, throw-away database.
import { db, resetDb, seedShopModel } from './_harness'
import { strongTestKey } from './_keys'
import { installFakeCheckout } from './_fake-checkout'
import { guestHeaders, newGuestBrowser, type GuestBrowser } from './_guest'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { viewerGuards } from '../../lib/viewer'
import { readFileSync } from 'node:fs'
import { getRetentionPolicy, runDataRetentionCleanup } from '../../lib/data-retention'
import { deleteUserPrivacyData } from '../../lib/privacy'
import { PAYMENT_IN_DOUBT_SQL, PAYMENT_IN_DOUBT_WHERE } from '../../lib/payment-in-doubt'

const DAY = 24 * 60 * 60 * 1000
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of [...Object.keys(ENV), 'DATA_RETENTION_GUEST_SESSION_DAYS']) saved[key] = process.env[key]
delete process.env.DATA_RETENTION_GUEST_SESSION_DAYS
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT
let ipSeq = 0
const nextIp = () => `10.10.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`

let seq = 0
const HASH = 'a'.repeat(64)
type Spec = { name: string; age: number; order?: Record<string, unknown>; attempt?: string; keeps: boolean }
// every state an old guest order can be in, and whether the hash may go
const MATRIX: Spec[] = [
  { name: 'paid and in the queue', age: 60, order: { status: 'queued', paymentStatus: 'paid', paidAt: new Date() }, keeps: false },
  { name: 'paid and finished', age: 60, order: { status: 'completed', paymentStatus: 'paid', paidAt: new Date() }, attempt: 'paid', keeps: false },
  { name: 'abandoned (never paid)', age: 60, keeps: false },
  { name: 'cancelled, page expired', age: 60, order: { status: 'cancelled', paymentStatus: 'canceled' }, attempt: 'expired', keeps: false },
  { name: 'a payment page still open', age: 60, attempt: 'open', keeps: false },
  { name: 'a payment page that failed', age: 60, attempt: 'failed', keeps: false },
  { name: 'payment being confirmed (order)', age: 60, order: { paymentStatus: 'processing' }, keeps: true },
  { name: 'payment being confirmed (attempt)', age: 60, attempt: 'processing', keeps: true },
  { name: 'payment that did not match', age: 60, attempt: 'mismatch', keeps: true },
  { name: 'a reason for a person to look', age: 60, order: { paymentStatus: 'paid', paymentReviewReason: 'dispute', paidAt: new Date() }, keeps: true },
  { name: 'money for a cancelled order', age: 60, order: { status: 'cancelled', paymentStatus: 'paid', paymentReviewReason: 'paid_after_cancel', paidAt: new Date() }, keeps: true },
  { name: 'paid but held for review', age: 60, order: { status: 'awaiting_review', paymentStatus: 'paid', paidAt: new Date() }, keeps: true },
  { name: 'young: paid', age: 10, order: { status: 'queued', paymentStatus: 'paid', paidAt: new Date() }, keeps: true },
  { name: 'young: abandoned', age: 10, keeps: true },
  { name: 'young: just under the limit', age: 44, keeps: true },
]
async function seed(spec: Spec, hash = HASH) {
  const prisma = await db()
  seq += 1
  const createdAt = new Date(Date.now() - spec.age * DAY)
  const order = await prisma.printOrder.create({
    data: {
      status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', currency: 'EUR', subtotalCents: 5000, totalCents: 5000,
      checkoutKey: `ret-key-${seq}-${'x'.repeat(40)}`, guestAccessTokenHash: 'b'.repeat(64), guestAccessExpiresAt: new Date(createdAt.getTime() + 3 * DAY),
      guestSessionHash: hash, createdAt, updatedAt: new Date(createdAt.getTime() + DAY),
      metadata: { source: 'stripe_checkout', note: `keep-${seq}`, productionAuthorization: { authorized: true, by: 'admin1' } },
      ...(spec.order || {}),
      items: { create: [{ modelTitle: 'Part', material: 'PLA', quantity: 1, unitPriceCents: 5000, totalCents: 5000 }] },
    } as any,
  })
  if (spec.attempt) {
    await prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: 5000, currency: 'EUR', status: spec.attempt, expiresAt: new Date(createdAt.getTime() + 32 * 60_000) } })
  }
  return order
}
async function seedMatrix() {
  const rows: Array<{ spec: Spec; id: string }> = []
  for (const spec of MATRIX) rows.push({ spec, id: (await seed(spec)).id })
  return rows
}
const reload = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id } })
const withoutHash = (row: Record<string, unknown>) => {
  const { guestSessionHash: _ignored, ...rest } = row
  return JSON.stringify(rest)
}

test.before(async () => { await resetDb() })
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})
test.beforeEach(async () => {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
})

test('the policy: 45 days by default, from DATA_RETENTION_GUEST_SESSION_DAYS, and a wrong value falls back to 45', () => {
  assert.equal(getRetentionPolicy().guestSessionDays, 45)
  assert.ok(getRetentionPolicy().guestSessionDays * DAY > 30 * DAY, 'longer than the life of the cookie')
  for (const [value, expected] of [['10', 10], ['0', 45], ['-3', 45], ['abc', 45], ['', 45]] as Array<[string, number]>) {
    process.env.DATA_RETENTION_GUEST_SESSION_DAYS = value
    assert.equal(getRetentionPolicy().guestSessionDays, expected, `"${value}"`)
  }
  delete process.env.DATA_RETENTION_GUEST_SESSION_DAYS
})

test('the hash goes from old orders that nobody waits on, stays on young ones and on every order whose payment is in doubt', async () => {
  const rows = await seedMatrix()
  const summary = await runDataRetentionCleanup()
  assert.equal(summary.guestSessionHashesCleared, MATRIX.filter((spec) => !spec.keeps).length)
  for (const { spec, id } of rows) {
    const order = await reload(id)
    assert.equal(order.guestSessionHash, spec.keeps ? HASH : null, spec.name)
  }
})

test('ONLY the hash changes: not the metadata, the review reason, the payment markers, the access token, the key - and not updatedAt', async () => {
  const rows = await seedMatrix()
  const before = new Map<string, string>()
  const attemptsBefore = JSON.stringify(await (await db()).paymentAttempt.findMany({ orderBy: { id: 'asc' } }))
  for (const { id } of rows) before.set(id, withoutHash(await reload(id) as any))
  await runDataRetentionCleanup()
  for (const { spec, id } of rows) assert.equal(withoutHash(await reload(id) as any), before.get(id), `${spec.name}: everything but the hash is as it was`)
  assert.equal(JSON.stringify(await (await db()).paymentAttempt.findMany({ orderBy: { id: 'asc' } })), attemptsBefore)
  // the access to the status page and the production authorization are still there
  const cleared = await reload(rows[0].id)
  assert.equal(cleared.guestAccessTokenHash, 'b'.repeat(64))
  assert.deepEqual((cleared.metadata as any).productionAuthorization, { authorized: true, by: 'admin1' })
})

test('a dry run counts what a run would empty and changes nothing; a second run finds nothing more', async () => {
  const rows = await seedMatrix()
  const snapshot = JSON.stringify(await Promise.all(rows.map(({ id }) => reload(id))))
  const dry = await runDataRetentionCleanup({ dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.guestSessionHashesCleared, MATRIX.filter((spec) => !spec.keeps).length)
  assert.equal(JSON.stringify(await Promise.all(rows.map(({ id }) => reload(id)))), snapshot, 'nothing changed')
  const real = await runDataRetentionCleanup()
  assert.equal(real.guestSessionHashesCleared, dry.guestSessionHashesCleared)
  assert.equal((await runDataRetentionCleanup()).guestSessionHashesCleared, 0)
})

test('the number of days can be changed; an order of an account (no hash) is never in the picture', async () => {
  const young = await seed({ name: 'x', age: 10, keeps: false })
  const accountOrder = await seed({ name: 'account', age: 90, keeps: false }, HASH)
  const prisma = await db()
  const user = await prisma.user.create({ data: { email: 'ret-user@sectest.invalid', passwordHash: 'x', name: 'ret', role: 'customer' } })
  await prisma.printOrder.update({ where: { id: accountOrder.id }, data: { userId: user.id, guestSessionHash: null } })
  assert.equal((await runDataRetentionCleanup({ dryRun: true })).guestSessionHashesCleared, 0, '10 days old: kept at the default')
  process.env.DATA_RETENTION_GUEST_SESSION_DAYS = '5'
  try {
    assert.equal((await runDataRetentionCleanup()).guestSessionHashesCleared, 1)
    assert.equal((await reload(young.id)).guestSessionHash, null)
    const account = await reload(accountOrder.id)
    assert.equal(account.userId, user.id)
    assert.equal(account.guestSessionHash, null)
  } finally {
    delete process.env.DATA_RETENTION_GUEST_SESSION_DAYS
  }
})

test('the JavaScript rule and the SQL rule pick the same orders (the guard against a second payment, and the retention that must not undo it)', async () => {
  const rows = await seedMatrix()
  const prisma = await db()
  const byPrisma = (await prisma.printOrder.findMany({ where: PAYMENT_IN_DOUBT_WHERE, select: { id: true } })).map((row) => row.id).sort()
  const bySql = (await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "PrintOrder" WHERE ${PAYMENT_IN_DOUBT_SQL}`)).map((row) => row.id).sort()
  assert.deepEqual(bySql, byPrisma)
  const expected = rows.filter(({ spec }) => spec.keeps && spec.age >= 45).map(({ id }) => id).sort()
  assert.deepEqual(byPrisma.filter((id) => expected.includes(id)), expected, 'every old order in doubt is one of them')
  assert.equal(byPrisma.length, rows.filter(({ spec }) => /confirmed|match|reason|cancelled order|review/.test(spec.name)).length)
})

test('the per-session request counters go with the hash: the guest ones older than the limit are deleted, the others stay', async () => {
  const prisma = await db()
  const old = new Date(Date.now() - 60 * DAY)
  const recent = new Date(Date.now() - 2 * DAY)
  const rows = [
    ['checkout:quote:guest:' + HASH, old, true], ['checkout:session:guest:' + HASH, old, true],
    ['checkout:session:guest:' + 'c'.repeat(64), recent, false],
    ['checkout:session:ip:10.0.0.1', old, false], ['checkout:quote:all', old, false], ['checkout:session:user:u1', old, false], ['login:someone', old, false],
  ] as Array<[string, Date, boolean]>
  for (const [key, updatedAt] of rows) await prisma.rateLimit.create({ data: { key, count: 1, resetAt: new Date(updatedAt.getTime() + 600_000), updatedAt } })
  const dry = await runDataRetentionCleanup({ dryRun: true })
  assert.equal(dry.guestRateLimitEntriesDeleted, 2)
  assert.equal(await prisma.rateLimit.count(), rows.length)
  const run = await runDataRetentionCleanup()
  assert.equal(run.guestRateLimitEntriesDeleted, 2)
  const left = (await prisma.rateLimit.findMany()).map((row) => row.key).sort()
  assert.deepEqual(left, rows.filter((row) => !row[2]).map((row) => row[0]).sort())
})

test('a payment in doubt keeps working after the job: the same browser is still refused a second payment of the same cart, and an old settled order is simply gone from the guard', async () => {
  const prisma = await db()
  await resetDb()
  const fake = await installFakeCheckout()
  Object.assign(process.env, ENV)
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  const modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  const browser: GuestBrowser = newGuestBrowser()
  const cart = { items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' }, rush: false }
  const call = async (route: 'quote' | 'session', body: unknown) => {
    viewerGuards.getViewer = async () => null
    const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
    const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders({}, browser) }, body: JSON.stringify(body),
    }), {})) as Response
    return { status: res.status, json: await res.json() as any }
  }
  const total = (await call('quote', cart)).json.totalCents as number
  const first = await call('session', { checkoutKey: strongTestKey('retention-key-0000000001'), expectedTotalCents: total, ...cart })
  assert.equal(first.status, 200)
  // 60 days later, the payment is still being confirmed: the hash stays and the guard still knows the browser
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { paymentStatus: 'processing', createdAt: new Date(Date.now() - 60 * DAY) } })
  await runDataRetentionCleanup()
  assert.equal((await reload(first.json.orderId)).guestSessionHash, browser.hash)
  const again = await call('session', { checkoutKey: strongTestKey('retention-key-0000000002'), expectedTotalCents: total, ...cart })
  assert.equal(again.status, 409, JSON.stringify(again.json))
  assert.equal(again.json.code, 'PAYMENT_IN_PROGRESS')
  // once it is resolved and old, the hash goes and the browser is free to buy the same things again
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date() } })
  await prisma.paymentAttempt.updateMany({ where: { orderId: first.json.orderId }, data: { status: 'paid' } })
  await runDataRetentionCleanup()
  assert.equal((await reload(first.json.orderId)).guestSessionHash, null)
  const next = await call('session', { checkoutKey: strongTestKey('retention-key-0000000003'), expectedTotalCents: total, ...cart })
  assert.equal(next.status, 200, JSON.stringify(next.json))
  assert.notEqual(next.json.orderId, first.json.orderId)
  assert.ok(fake.state.createdSessions >= 2)
})

test('the cleanup route (it now writes orders too) refuses a request from another site before it touches anything; the signed-in administrator\'s own page can run it', async () => {
  const rows = await seedMatrix()
  const snapshot = JSON.stringify(await Promise.all(rows.map(({ id }) => reload(id))))
  const { POST } = await import('../../app/api/admin/data-retention/route')
  const request = (origin: string | null, body: unknown) => new NextRequest('http://localhost/api/admin/data-retention', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  })
  viewerGuards.getViewer = async () => null
  assert.equal((await POST(request('http://localhost', {}))).status, 401, 'nobody')
  viewerGuards.getViewer = async () => ({ id: 'cust-1', role: 'customer' })
  assert.equal((await POST(request('http://localhost', {}))).status, 403, 'a customer')
  viewerGuards.getViewer = async () => ({ id: 'admin-1', role: 'admin' })
  assert.equal((await POST(request('https://attacker.example', {}))).status, 403, 'another site')
  assert.equal((await POST(request(null, {}))).status, 403, 'no information about where it comes from')
  assert.equal(JSON.stringify(await Promise.all(rows.map(({ id }) => reload(id)))), snapshot, 'and nothing was touched')
  const own = await POST(request('http://localhost', { dryRun: true }))
  assert.equal(own.status, 200)
  const body = await own.json() as any
  assert.equal(body.summary.dryRun, true)
  assert.equal(body.summary.guestSessionHashesCleared, MATRIX.filter((spec) => !spec.keeps).length)
})

test('account deletion (lib/privacy.ts, unchanged by this step) has nothing to do with the hash: it only touches the account\'s own orders, which never carry one, and leaves every guest order as it was', async () => {
  const prisma = await db()
  const guest = await seed({ name: 'guest', age: 5, keeps: true })
  const user = await prisma.user.create({ data: { email: 'ret-privacy@sectest.invalid', passwordHash: 'x', name: 'ret', role: 'customer' } })
  const mine = await seed({ name: 'mine', age: 5, keeps: true })
  await prisma.printOrder.update({ where: { id: mine.id }, data: { userId: user.id, guestSessionHash: null, customerEmail: 'ret-privacy@sectest.invalid', customerName: 'ret' } })
  const guestBefore = JSON.stringify(await reload(guest.id))
  await deleteUserPrivacyData(user.id)
  const after = await reload(mine.id)
  assert.equal(after.userId, null)
  assert.equal(after.customerEmail, null)
  assert.equal(after.guestSessionHash, null, 'an order of an account never carried a session hash')
  assert.equal(JSON.stringify(await reload(guest.id)), guestBefore, 'and a guest order is not in its reach')
  // the privacy module was not changed to know about it: there is nothing to reconcile between deleting a person\'s data and the markers an order needs
  assert.ok(!/guestSession/i.test(readFileSync(new URL('../../lib/privacy.ts', import.meta.url), 'utf8')))
})
