// DR-13 phase 1: the same questions asked of REAL separate processes (their own memory, their own database connections) that meet at the same payment page, against the SHARED
// stand-in for Stripe (its state lives in the database, so every process sees the same pages and the same idempotency keys) and the monitor that reads that state.
// The clock offset is passed to every child (SIM_CLOCK_OFFSET_MS), so parent and children agree on "now".
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { bootKit, SESSION_TTL_MS, type Kit } from './_dr13-kit'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh() })
test.after(async () => { await k.fresh(); await k.sim.close() })

const started: ChildProcess[] = []
test.afterEach(() => { for (const proc of started.splice(0)) { try { proc.kill('SIGKILL') } catch { /* gone */ } } })

type ChildResult = { label: string; mode: string; kind?: string; status?: number | null; code?: string | null; reason?: string | null; url?: string | null; attemptId?: string | null; startedLateByMs?: number; exit: number | null }
function runChild(label: string, orderId: string, startAt: number, extra: Record<string, string> = {}): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let output = ''
    const proc = spawn(process.execPath, ['--import', 'tsx', 'tests/security/_dr13-child.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, CHILD_LABEL: label, CHILD_ORDER: orderId, CHILD_START_AT: String(startAt), SIM_CLOCK_OFFSET_MS: String(k.clock.offset()), PAYMENT_SYNC_MAX_WAIT_MS: '6000', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    started.push(proc)
    proc.stdout?.on('data', (chunk) => { output += chunk })
    proc.stderr?.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`child ${label} did not finish in 90 s:\n${output}`)) }, 90_000)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      const line = output.split('\n').find((l) => l.startsWith('RESULT '))
      if (!line) return resolve({ label, mode: 'none', exit: code, kind: 'no_result' } as ChildResult)
      resolve({ ...JSON.parse(line.slice(7)), exit: code })
    })
  })
}
async function runChildren(count: number, orderId: string, extra: Record<string, string> = {}) {
  const startAt = Date.now() + 2500
  return Promise.all(Array.from({ length: count }, (_, i) => runChild(`p${i}`, orderId, startAt, extra)))
}
// every page a child handed out is judged exactly as a page the route handed out
async function observeChildren(orderId: string, results: ChildResult[]) {
  for (const r of results) if (r.kind === 'open' && r.url) await k.observe(orderId, { status: 200, json: { url: r.url } }, `child ${r.label}`)
}

test('MP margin: four REAL processes ask for a page with 30 s left at the same moment -> the old page is closed at the provider first; ONE new page for all; never two payable', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS - 30_000)
  const results = await runChildren(4, a.orderId)
  assert.deepEqual(results.map((r) => r.exit), [0, 0, 0, 0], JSON.stringify(results))
  await observeChildren(a.orderId, results)
  await k.assertClean('MP margin')
  const urls = new Set(results.filter((r) => r.kind === 'open').map((r) => r.url))
  assert.ok(urls.size <= 1, `different pages were handed out: ${[...urls].join(', ')}`)
  assert.equal((await k.sim.payable(a.orderId)).length <= 1, true)
  const attempts = await k.attemptsOf(a.orderId)
  assert.ok(attempts.filter((x) => x.status === 'creating' || x.status === 'open').length <= 1, JSON.stringify(attempts.map((x) => x.status)))
  assert.ok(results.every((r) => r.kind === 'open' || r.status === 503), `unexpected outcomes: ${JSON.stringify(results)}`)
})

test('MP reservation: a reservation whose answer was lost is found by four REAL processes after 5 minutes -> no second page is opened by any of them', async () => {
  k.sim.faults.createLostAnswer = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  const order = await k.onlyOrder()
  assert.ok(first.status === 502 || first.status === 503)
  await k.travel(5 * 60_000)
  const results = await runChildren(4, order.id)
  assert.deepEqual(results.map((r) => r.exit), [0, 0, 0, 0], JSON.stringify(results))
  await observeChildren(order.id, results)
  await k.assertClean('MP reservation')
  assert.equal(await k.sim.createdSessions(), 1, 'a second session was created next to the one the lost answer may have left')
  assert.equal((await k.attemptsOf(order.id)).length, 1)
})
