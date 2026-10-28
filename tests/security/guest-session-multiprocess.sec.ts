// Step 4.6 (S5) – the rule "one browser session + one purchase attempt = ONE order and ONE payment page" must hold between REAL separate processes (two
// servers behind a load balancer, a worker and a request), not only inside one: the lock that decides it lives in the database.
//
// Each scenario starts two real Node processes (tests/security/_guest-session-child.ts) against the same PostgreSQL database. Each runs the real "pay" route with
// its own connections and a shared stand-in for Stripe (it keeps one session per idempotency key, like the real one). They wait at a barrier and fire together.
//   A. same session, DIFFERENT keys, same cart (two tabs, localStorage not shared), repeated in rounds -> one order, one attempt, one Stripe session;
//   B. same session, the SAME key (a double click that reached two servers) -> the same;
//   C. several requests at once in each process (6 keys) -> still one;
//   D. no session cookie at all -> all 428, nothing in the database, no call to Stripe;
//   E. two DIFFERENT guests, the SAME key and the same cart -> ONE order, ONE session at Stripe: the other is refused and sees nothing of the first (R1-1b);
//   F. RESIDUO R1, the form that remains: two first requests with different new sessions AND different keys -> two orders (written down, not closed);
//   G. the lock itself: with every request held INSIDE it for a while, two processes are never inside together (their time spans do not overlap);
//   H. the lock of the PURCHASE KEY is a mutual exclusion between processes too: two sessions, one key, held inside -> never inside together, one order (R1-1b);
//   I. the guard is in the database, not in a process: a process started LATER, with another session and the same key, is refused (R1-1b);
//   J. the lock of the key taken away in both processes: the primary key of the table still lets only ONE order stand (R1-1b).
import { db, resetDb, seedShopModel } from './_harness'
import { strongTestKey } from './_keys'
import { newGuestBrowser, type GuestBrowser } from './_guest'
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'
import { purchaseKeyFor } from '../../lib/purchase-intent'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const dir = mkdtempSync(path.join(os.tmpdir(), 'mkw-guestproc-'))
const logFile = path.join(dir, 'log.txt')
writeFileSync(logFile, '')

type LogLine = { at: number; label: string; what: string }
const readLog = (): LogLine[] => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => {
  const [at, label, ...rest] = line.split(' ')
  return { at: Number(at), label, what: rest.join(' ') }
})
async function waitFor(predicate: () => boolean, what: string, ms = 30_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`${what} not seen in ${ms} ms:\n${readFileSync(logFile, 'utf8')}`)
}

const started: ChildProcess[] = []
test.afterEach(() => { for (const proc of started.splice(0)) { try { proc.kill('SIGKILL') } catch { /* gone */ } } })

const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT
let modelId = ''
let ipSeq = 0
const nextIp = () => `10.11.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => strongTestKey(`mp-${++keySeq}`)
let round = 0

const cartBody = (qty = 2) => ({ items: [{ modelId, qty, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' }, rush: false })
async function quoteTotal(qty = 2) {
  viewerGuards.getViewer = async () => null
  const mod = await import('../../app/api/checkout/quote/route')
  const res = (await (mod.POST as any)(new NextRequest('http://localhost/api/checkout/quote', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(cartBody(qty)),
  }), {})) as Response
  assert.equal(res.status, 200)
  return (await res.json()).totalCents as number
}
const payBody = (total: number, key: string, qty = 2) => ({ checkoutKey: key, expectedTotalCents: total, ...cartBody(qty) })

type ChildRequest = { key: string; browser: GuestBrowser | null }
// Two (or more) real processes, started, held at the barrier, released together. Returns what each of their requests got.
// `sameStripeAs`: the stand-in for Stripe of an earlier call - the payment pages made there are still there (the process of a later call is another server in front of the same Stripe)
async function race(children: ChildRequest[][], total: number, qty = 2, holdMs = 150, extraEnv: Record<string, string> = {}, sameStripeAs?: { stripeDir: string }) {
  round += 1
  const stripeDir = sameStripeAs?.stripeDir ?? path.join(dir, `stripe-${round}`)
  const go = path.join(dir, `go-${round}`)
  const labels = children.map((_, index) => `R${round}-${index}`)
  children.forEach((requests, index) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'tests/security/_guest-session-child.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env, ...ENV, CHILD_LABEL: labels[index], CHILD_LOG: logFile, CHILD_GO_FILE: go, CHILD_STRIPE_DIR: stripeDir, CHILD_HOLD_MS: String(holdMs), ...extraEnv,
        CHILD_REQUESTS: JSON.stringify(requests.map((request) => ({ route: 'session', body: payBody(total, request.key, qty), cookie: request.browser?.cookie, ip: nextIp() }))),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    proc.stdout?.on('data', (chunk) => { output += chunk })
    proc.stderr?.on('data', (chunk) => { output += chunk })
    ;(proc as any).output = () => output
    started.push(proc)
  })
  await waitFor(() => labels.every((label) => readLog().some((line) => line.label === label && line.what === 'ready')), 'both processes ready')
  writeFileSync(go, 'go')
  await waitFor(() => labels.every((label) => readLog().some((line) => line.label === label && line.what.startsWith('result'))) || readLog().some((line) => line.what.startsWith('crashed')), 'every request answered')
  assert.ok(!readLog().some((line) => line.what.startsWith('crashed')), readFileSync(logFile, 'utf8'))
  await Promise.all(started.splice(0).map((proc) => new Promise((resolve) => { proc.on('exit', resolve); if (proc.exitCode !== null) resolve(null) })))
  const lines = readLog().filter((line) => labels.includes(line.label))
  const results = lines.filter((line) => line.what.startsWith('result')).map((line) => {
    const fields = Object.fromEntries(line.what.split(' ').slice(2).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
    return { label: line.label, status: Number(fields.status), order: fields.order as string, url: fields.url as string, code: fields.code as string, sid: fields.sid as string }
  })
  const creates = lines.filter((line) => line.what.startsWith('stripe.create')).map((line) => {
    const fields = Object.fromEntries(line.what.split(' ').slice(1).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
    return { label: line.label, isNew: line.what.startsWith('stripe.create new'), key: fields.key as string, order: fields.order as string, session: fields.session as string }
  })
  // when each request was inside the lock (the order of the lines in the log is the order in time)
  const spans: Array<{ label: string; from: number; to: number }> = []
  for (const label of labels) {
    const mine = lines.filter((line) => line.label === label && (line.what === 'lock-enter' || line.what === 'lock-leave'))
    for (let i = 0; i + 1 < mine.length; i += 2) spans.push({ label, from: mine[i].at, to: mine[i + 1].at })
  }
  return { results, creates, spans, stripeDir }
}
const ordersOf = async (browser: GuestBrowser) => (await db()).printOrder.findMany({ where: { guestSessionHash: browser.hash }, include: { paymentAttempts: true } })
const aliasesOf = async (orderId: string) => (await db()).guestPurchaseKey.findMany({ where: { orderId } })
const fingerprintOf = (key: string) => purchaseKeyFor(key) as string

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

test('A. two processes, one browser session, DIFFERENT keys, the same cart - six rounds: every round is ONE order, ONE attempt and ONE Stripe session', async () => {
  const total = await quoteTotal()
  for (let i = 0; i < 6; i++) {
    const browser = newGuestBrowser()
    const keys = [newKey(), newKey()]
    const { results, creates } = await race([[{ key: keys[0], browser }], [{ key: keys[1], browser }]], total)
    assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results))
    assert.equal(new Set(results.map((r) => r.order)).size, 1, `round ${i}: both processes got the same order`)
    assert.equal(new Set(results.map((r) => r.url)).size, 1, `round ${i}: and the same payment page`)
    const orders = await ordersOf(browser)
    assert.equal(orders.length, 1, `round ${i}: one order in the database`)
    assert.equal(orders[0].paymentAttempts.length, 1, `round ${i}: one payment attempt`)
    assert.equal(orders[0].id, results[0].order)
    assert.deepEqual((await aliasesOf(orders[0].id)).map((row) => row.keyHash).sort(), keys.map(fingerprintOf).sort(), `round ${i}: both keys are bound to the one order`)
    assert.equal(new Set(creates.map((c) => c.key)).size, 1, `round ${i}: every call to Stripe carried the same idempotency key`)
    assert.equal(new Set(creates.map((c) => c.session)).size, 1, `round ${i}: Stripe made ONE session`)
    assert.equal(creates.filter((c) => c.isNew).length, 1)
    assert.ok(creates[0].key.endsWith(orders[0].paymentAttempts[0].id), 'and that key is the attempt\'s')
  }
})

test('B. two processes, one browser session, the SAME key (a double click that reached two servers): one order, one payment page', async () => {
  const total = await quoteTotal()
  for (let i = 0; i < 3; i++) {
    const browser = newGuestBrowser()
    const key = newKey()
    const { results, creates } = await race([[{ key, browser }], [{ key, browser }]], total)
    assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results))
    assert.equal(new Set(results.map((r) => r.order)).size, 1)
    assert.equal((await ordersOf(browser)).length, 1)
    assert.equal(new Set(creates.map((c) => c.session)).size, 1)
    assert.deepEqual((await aliasesOf(results[0].order)).map((row) => row.keyHash), [fingerprintOf(key)], 'one key, one binding')
  }
})

test('C. six requests at once (three in each process, six different keys), one browser session: ONE order and ONE Stripe session', async () => {
  const total = await quoteTotal(3)
  const browser = newGuestBrowser()
  const sent: string[] = []
  const make = () => Array.from({ length: 3 }, () => { const key = newKey(); sent.push(key); return { key, browser } })
  const { results, creates } = await race([make(), make()], total, 3)
  assert.equal(results.length, 6)
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results))
  assert.equal(new Set(results.map((r) => r.order)).size, 1)
  const orders = await ordersOf(browser)
  assert.equal(orders.length, 1)
  assert.deepEqual((await aliasesOf(orders[0].id)).map((row) => row.keyHash).sort(), sent.map(fingerprintOf).sort(), 'all six keys are bound to the one order')
  assert.equal(orders[0].paymentAttempts.length, 1)
  assert.equal(new Set(creates.map((c) => c.session)).size, 1)
})

test('D. two processes, NO session cookie: every request is 428, nothing is written, Stripe is never called', async () => {
  const total = await quoteTotal()
  const prisma = await db()
  const before = { orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count() }
  const { results, creates } = await race([[{ key: newKey(), browser: null }, { key: newKey(), browser: null }], [{ key: newKey(), browser: null }, { key: newKey(), browser: null }]], total)
  assert.equal(results.length, 4)
  assert.ok(results.every((r) => r.status === 428 && r.code === 'SESSION_REQUIRED' && r.sid === 'set' && r.order === '-'), JSON.stringify(results))
  assert.deepEqual({ orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count() }, before)
  assert.equal(creates.length, 0)
})

test('E. two processes, two DIFFERENT guests with the SAME key and the same cart: ONE order, ONE Stripe session - the other is refused, with nothing of the first in its answer (R1-1b)', async () => {
  const total = await quoteTotal()
  const alice = newGuestBrowser()
  const bob = newGuestBrowser()
  const key = newKey()
  const { results, creates } = await race([[{ key, browser: alice }], [{ key, browser: bob }]], total)
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results))
  const winner = results.find((r) => r.status === 200)!
  const loser = results.find((r) => r.status === 409)!
  assert.equal(loser.code, 'PURCHASE_KEY_IN_USE')
  assert.equal(loser.order, '-', 'no order in the refusal')
  assert.equal(loser.url, '-', 'no payment page in the refusal')
  assert.equal(loser.sid, 'none', 'and no cookie')
  const mine = [...await ordersOf(alice), ...await ordersOf(bob)]
  assert.equal(mine.length, 1, 'one order between the two of them')
  assert.equal(mine[0].id, winner.order)
  assert.equal(new Set(creates.map((c) => c.session)).size, 1, 'Stripe was asked for ONE session')
  assert.deepEqual((await aliasesOf(winner.order)).map((row) => row.keyHash), [fingerprintOf(key)])
})

test('F. RESIDUO R1 (not closed, in the form that remains): two first requests with different new sessions AND different keys make two orders - the server can not tell they are one browser', async () => {
  const total = await quoteTotal()
  const tabOne = newGuestBrowser()
  const tabTwo = newGuestBrowser()
  const { results } = await race([[{ key: newKey(), browser: tabOne }], [{ key: newKey(), browser: tabTwo }]], total)
  assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results))
  assert.equal(new Set(results.map((r) => r.order)).size, 2, 'R1: two orders')
  assert.equal((await ordersOf(tabOne)).length + (await ordersOf(tabTwo)).length, 2)
})

test('G. the lock is a real mutual exclusion between processes: with every request held inside it, two processes are never inside at the same time', async () => {
  const total = await quoteTotal()
  const browser = newGuestBrowser()
  const { results, spans } = await race([[{ key: newKey(), browser }], [{ key: newKey(), browser }]], total, 2, 400)
  assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results))
  assert.equal(new Set(results.map((r) => r.order)).size, 1)
  assert.equal(spans.length, 2, `both requests went through the lock: ${JSON.stringify(spans)}`)
  const [first, second] = [...spans].sort((a, b) => a.from - b.from)
  assert.ok(first.to - first.from >= 380, `the first was held for the whole time (${first.to - first.from} ms)`)
  assert.ok(second.from >= first.to, `the second only entered after the first had left: ${JSON.stringify(spans)}`)
  assert.equal((await ordersOf(browser)).length, 1)
})

test('H. the lock of the PURCHASE KEY is a real mutual exclusion between processes: two different sessions, one key, every request held inside it - never inside together, and ONE order', async () => {
  const total = await quoteTotal()
  const alice = newGuestBrowser()
  const bob = newGuestBrowser()
  const key = newKey()
  const { results, spans, creates } = await race([[{ key, browser: alice }], [{ key, browser: bob }]], total, 2, 400)
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results))
  assert.equal(spans.length, 2, `both requests went through the lock: ${JSON.stringify(spans)}`)
  const [first, second] = [...spans].sort((a, b) => a.from - b.from)
  assert.ok(first.to - first.from >= 380, `the first was held for the whole time (${first.to - first.from} ms)`)
  assert.ok(second.from >= first.to, `the second only entered after the first had left: ${JSON.stringify(spans)}`)
  assert.equal((await ordersOf(alice)).length + (await ordersOf(bob)).length, 1)
  assert.equal(new Set(creates.map((c) => c.session)).size, 1)
})

test('I. the guard is in the database and not in a process: a process started LATER, with another session and the same key, is refused - and the first browser, in yet another process, is served', async () => {
  const total = await quoteTotal()
  const alice = newGuestBrowser()
  const bob = newGuestBrowser()
  const key = newKey()
  const one = await race([[{ key, browser: alice }]], total)
  assert.deepEqual(one.results.map((r) => r.status), [200], JSON.stringify(one.results))
  const later = await race([[{ key, browser: bob }]], total, 2, 150, {}, one)
  assert.deepEqual(later.results.map((r) => r.status), [409], JSON.stringify(later.results))
  assert.equal(later.results[0].code, 'PURCHASE_KEY_IN_USE')
  assert.equal(later.results[0].order, '-')
  assert.equal(later.creates.length, 0, 'the refused process asked Stripe for nothing')
  const again = await race([[{ key, browser: alice }]], total, 2, 150, {}, one)
  assert.deepEqual(again.results.map((r) => r.status), [200], JSON.stringify(again.results))
  assert.equal(again.results[0].order, one.results[0].order)
  assert.equal((await ordersOf(alice)).length + (await ordersOf(bob)).length, 1)
})

test('J. the lock of the key taken away in BOTH processes and every request held inside for a while: the primary key of the table still lets only ONE order stand, and the other is refused', async () => {
  const total = await quoteTotal()
  for (let i = 0; i < 3; i++) {
    const alice = newGuestBrowser()
    const bob = newGuestBrowser()
    const key = newKey()
    const { results, creates } = await race([[{ key, browser: alice }], [{ key, browser: bob }]], total, 2, 400, { CHILD_NO_PK_LOCK: '1' })
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], `round ${i}: ${JSON.stringify(results)}`)
    const winner = results.find((r) => r.status === 200)!
    assert.equal(results.find((r) => r.status === 409)!.code, 'PURCHASE_KEY_IN_USE')
    assert.equal(new Set(creates.map((c) => c.session)).size, 1, `round ${i}: ONE session at Stripe`)
    assert.deepEqual((await aliasesOf(winner.order)).map((row) => row.keyHash), [fingerprintOf(key)], `round ${i}: one binding`)
  }
  // several keys of one purchase may be bound to the SAME order (two tabs, two keys, one cart): the orders are counted once each
  const prisma = await db()
  const boundOrderIds = [...new Set((await prisma.guestPurchaseKey.findMany()).map((row) => row.orderId))]
  assert.equal(await prisma.printOrder.count({ where: { id: { in: boundOrderIds } } }), boundOrderIds.length, 'every binding has its order')
})
