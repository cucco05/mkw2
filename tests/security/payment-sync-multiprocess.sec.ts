// Step 4.0c – the payment-sync permission (lease) must hold between REAL separate processes, not only inside one.
// Each scenario starts real Node processes against the same PostgreSQL database (tests/security/_payment-sync-child.ts):
//   A. two processes read Stripe for the same order: their reads never overlap, the order is released once, effects run once;
//   B. a process is killed (SIGKILL) while it holds the permission: another process takes over after it expires, nothing is lost;
//   C. a process is frozen (SIGSTOP) between reading Stripe and applying, its permission expires and another process finishes the
//      job; when the first one wakes up (SIGCONT) it applies NOTHING (it lost the permission);
//   D. two processes, a burst of events each: still one release, one set of effects, every event recorded once;
//   E. a Stripe read that takes too long is abandoned before the permission can expire: nothing is applied, the permission is given back.
import { db, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const dir = mkdtempSync(path.join(os.tmpdir(), 'mkw-multiproc-'))
const logFile = path.join(dir, 'log.txt')
writeFileSync(logFile, '')

type LogLine = { at: number; label: string; what: string }
const readLog = (): LogLine[] => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => {
  const [at, label, ...rest] = line.split(' ')
  return { at: Number(at), label, what: rest.join(' ') }
})
const lines = (label?: string) => readLog().filter((line) => !label || line.label === label)
async function waitForLog(predicate: (line: LogLine) => boolean, ms = 20_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const found = readLog().find(predicate)
    if (found) return found
    await sleep(25)
  }
  throw new Error(`log line not seen in ${ms} ms:\n${readFileSync(logFile, 'utf8')}`)
}

const started: ChildProcess[] = []
// Whatever happens in a test (a failed assertion included), no helper process may be left running - or frozen - behind it.
test.afterEach(() => {
  for (const proc of started.splice(0)) {
    try { proc.kill('SIGCONT'); proc.kill('SIGKILL') } catch { /* already gone */ }
  }
})

type Child = { proc: ChildProcess; label: string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; output: () => string }
function startChild(label: string, sessionFile: string, events: string[], extra: Record<string, string> = {}): Child {
  let output = ''
  const proc = spawn(process.execPath, ['--import', 'tsx', 'tests/security/_payment-sync-child.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, CHILD_LABEL: label, CHILD_LOG: logFile, CHILD_SESSION_FILE: sessionFile, CHILD_EVENTS: JSON.stringify(events),
      PAYMENT_SYNC_MAX_WAIT_MS: '8000', ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(proc)
  proc.stdout?.on('data', (chunk) => { output += chunk })
  proc.stderr?.on('data', (chunk) => { output += chunk })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })))
  return { proc, label, exited, output: () => output }
}

let seq = 0
// A hosted order waiting for payment, and the Stripe session that says it was paid exactly (what the fake Stripe of the children returns).
async function paidOrder() {
  seq += 1
  const prisma = await db()
  const order = await prisma.printOrder.create({
    data: {
      status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', currency: 'EUR', subtotalCents: 5000, totalCents: 5000,
      metadata: { source: 'stripe_checkout' },
      items: { create: [{ modelTitle: 'Part', material: 'PLA', quantity: 1, unitPriceCents: 5000, totalCents: 5000 }] },
    },
  })
  const sessionId = `cs_test_MULTIPROC_${seq}_${Date.now()}`
  const attempt = await prisma.paymentAttempt.create({
    data: { orderId: order.id, amountCents: 5000, currency: 'EUR', status: 'open', stripeSessionId: sessionId, expiresAt: new Date(Date.now() + 600_000) },
  })
  const metadata = { orderId: order.id, attemptId: attempt.id }
  const session = {
    id: sessionId, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 5000, currency: 'eur',
    client_reference_id: order.id, metadata, customer_details: { email: 'cliente@example.test', name: 'Cliente' },
    payment_intent: {
      id: `pi_test_MULTIPROC_${seq}`, object: 'payment_intent', status: 'succeeded', amount: 5000, amount_received: 5000, currency: 'eur', metadata, customer: null,
      latest_charge: { id: `ch_test_MULTIPROC_${seq}`, object: 'charge', receipt_url: null, amount_refunded: 0 },
    },
  }
  const file = path.join(dir, `session-${seq}.json`)
  writeFileSync(file, JSON.stringify({ session, orderId: order.id, attemptId: attempt.id }))
  return { orderId: order.id, attemptId: attempt.id, sessionId, file }
}
const reload = async (orderId: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id: orderId } })
const effectCount = (kind: string, since = 0) => readLog().filter((line) => line.what === `effect:${kind}` && line.at >= since).length

test.before(async () => { await resetDb() })

test('A. two processes, one order: their reads of Stripe never overlap; one release; effects run once', async () => {
  const t0 = Date.now()
  const { orderId, file } = await paidOrder()
  const first = startChild('A1', file, ['evt_A1'], { CHILD_READ_MS: '1200' })
  const second = startChild('A2', file, ['evt_A2'], { CHILD_READ_MS: '1200' })
  const [e1, e2] = await Promise.all([first.exited, second.exited])
  assert.equal(e1.code, 0, first.output())
  assert.equal(e2.code, 0, second.output())
  for (const label of ['A1', 'A2']) assert.ok(lines(label).some((l) => /^result evt_A\d ok$/.test(l.what)), `${label}: ${JSON.stringify(lines(label))}`)

  const window = (label: string) => ({
    start: Number(lines(label).find((l) => l.what === 'read_start')!.at),
    end: Number(lines(label).find((l) => l.what === 'read_end')!.at),
  })
  const a = window('A1')
  const b = window('A2')
  assert.ok(Math.max(a.start, b.start) >= Math.min(a.end, b.end), `the two reads overlapped: ${JSON.stringify({ a, b })}`)

  const order = await reload(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(order.paymentStatus, 'paid')
  assert.ok(order.paidAt)
  assert.equal(order.paymentSyncLeaseId, null, 'the permission is given back')
  assert.equal((await (await db()).stripeEvent.count({ where: { orderId } })), 2)
  assert.equal(effectCount('receipt', t0), 1, 'the after-payment effects ran once, not once per process')
})

test('B. a process killed while it holds the permission (and whose clock is an hour off): another takes over when it expires and nothing is lost', async () => {
  const { orderId, file } = await paidOrder()
  const ttl = { PAYMENT_SYNC_LEASE_TTL_MS: '2500' }
  // the doomed process thinks it is an hour later than it is: the permission must still last only its 2.5 seconds (database clock)
  const doomed = startChild('B1', file, ['evt_B1'], { CHILD_MODE: 'hang', CHILD_CLOCK_SKEW_MS: '3600000', ...ttl })
  const holdStart = await waitForLog((l) => l.label === 'B1' && l.what === 'read_start')
  assert.ok((await reload(orderId)).paymentSyncLeaseId, 'the doomed process holds the permission')
  doomed.proc.kill('SIGKILL')
  assert.equal((await doomed.exited).signal, 'SIGKILL')

  const rescuer = startChild('B2', file, ['evt_B2'], ttl)
  const done = await rescuer.exited
  assert.equal(done.code, 0, rescuer.output())
  assert.ok(lines('B2').some((l) => l.what === 'result evt_B2 ok'), JSON.stringify(lines('B2')))
  const takeover = lines('B2').find((l) => l.what === 'read_start')!
  assert.ok(takeover.at - holdStart.at >= 2300, `the second process did not wait for the permission to expire (${takeover.at - holdStart.at} ms)`)

  const order = await reload(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.paymentSyncLeaseId, null)
  const events = (await (await db()).stripeEvent.findMany({ where: { orderId } })).map((e) => e.id)
  assert.deepEqual(events, ['evt_B2'], 'the killed process recorded nothing')
  assert.equal(effectCount('receipt', holdStart.at), 1)
})

test('C. a frozen process whose permission expired applies nothing when it wakes up (another process finished the job)', async () => {
  const t0 = Date.now()
  const { orderId, file } = await paidOrder()
  const ttl = { PAYMENT_SYNC_LEASE_TTL_MS: '1500' }
  const sleeper = startChild('C1', file, ['evt_C1'], { CHILD_MODE: 'pause', CHILD_PAUSE_MS: '800', ...ttl })
  await waitForLog((l) => l.label === 'C1' && l.what === 'paused')
  sleeper.proc.kill('SIGSTOP') // frozen after reading Stripe, before applying
  await sleep(2200) // longer than the permission lasts

  const rescuer = startChild('C2', file, ['evt_C2'], ttl)
  const done = await rescuer.exited
  assert.equal(done.code, 0, rescuer.output())
  assert.ok(lines('C2').some((l) => l.what === 'result evt_C2 ok'), JSON.stringify(lines('C2')))
  const afterRescue = await reload(orderId)
  assert.equal(afterRescue.status, 'queued')
  const paidAt = afterRescue.paidAt!.getTime()

  sleeper.proc.kill('SIGCONT')
  const woke = await sleeper.exited
  assert.equal(woke.code, 0, sleeper.output())
  assert.ok(lines('C1').some((l) => l.what === 'result evt_C1 error:PaymentSyncLeaseLostError'), `the old holder must be refused: ${JSON.stringify(lines('C1'))}`)

  const order = await reload(orderId)
  assert.equal(order.paidAt!.getTime(), paidAt, 'the payment was not applied a second time')
  assert.equal(order.status, 'queued')
  assert.deepEqual((await (await db()).stripeEvent.findMany({ where: { orderId } })).map((e) => e.id), ['evt_C2'])
  assert.equal(effectCount('receipt', t0), 1, 'only the process that finished the job ran the effects')
})

test('D. two processes, a burst of events each: one release, one set of effects, every event recorded once', async () => {
  const { orderId, file } = await paidOrder()
  const mk = (prefix: string) => Array.from({ length: 6 }, (_, i) => `evt_D_${prefix}${i}`)
  const first = startChild('D1', file, mk('a'), { CHILD_READ_MS: '60' })
  const second = startChild('D2', file, mk('b'), { CHILD_READ_MS: '60' })
  const [e1, e2] = await Promise.all([first.exited, second.exited])
  assert.equal(e1.code, 0, first.output())
  assert.equal(e2.code, 0, second.output())
  const results = readLog().filter((l) => l.label.startsWith('D') && l.what.startsWith('result'))
  assert.equal(results.length, 12)
  assert.ok(results.every((r) => r.what.endsWith(' ok')), results.map((r) => r.what).join(' | '))
  const order = await reload(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(order.paymentSyncLeaseId, null)
  assert.equal(await (await db()).stripeEvent.count({ where: { orderId } }), 12)
  const prisma = await db()
  assert.equal((await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId } })).status, 'paid')
  const receipts = readLog().filter((l) => l.what === 'effect:receipt' && l.label.startsWith('D')).length
  assert.equal(receipts, 1, 'effects ran once across both processes')
})

test('E. a Stripe read that takes too long is abandoned before the permission can expire: nothing applied, permission given back', async () => {
  const { orderId, file } = await paidOrder()
  const ttl = { PAYMENT_SYNC_LEASE_TTL_MS: '1500' } // the whole reading phase may last 55 % of it (825 ms)
  const slow = startChild('E1', file, ['evt_E1'], { CHILD_READ_MS: '3500', ...ttl })
  const done = await slow.exited
  assert.equal(done.code, 0, slow.output())
  assert.ok(lines('E1').some((l) => l.what === 'result evt_E1 error:PaymentSyncReadTimeoutError'), JSON.stringify(lines('E1')))
  const order = await reload(orderId)
  assert.equal(order.status, 'awaiting_payment', 'nothing was applied')
  assert.equal(order.paymentSyncLeaseId, null, 'the permission was given back at once, not left to expire')
  assert.equal(await (await db()).stripeEvent.count({ where: { orderId } }), 0, 'the event stays unrecorded so Stripe delivers it again')
  // and the next attempt (Stripe's retry) works
  const retry = startChild('E2', file, ['evt_E1'], ttl)
  assert.equal((await retry.exited).code, 0, retry.output())
  assert.ok(lines('E2').some((l) => l.what === 'result evt_E1 ok'), JSON.stringify(lines('E2')))
  assert.equal((await reload(orderId)).status, 'queued')
})
