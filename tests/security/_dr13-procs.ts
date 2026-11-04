// REAL separate Node processes for the DR-13 tests (their own memory, their own database connections), against the SHARED stand-in for Stripe (its state lives in the database).
// The clock offset of the parent is handed to every child (SIM_CLOCK_OFFSET_MS), so that parent and children agree on "now". A child prints ONE line, `RESULT {json}`; one that dies on purpose
// (CHILD_CRASH, or a SIM_FAULTS crash fault of the stand-in) leaves no line and the exit code 137.
// Not a test file (its name does not match the test patterns).
import { spawn, type ChildProcess } from 'node:child_process'
import type { Kit } from './_dr13-kit'

export type ChildResult = { label: string; mode: string; kind?: string; status?: number | null; code?: string | null; reason?: string | null; url?: string | null; attemptId?: string | null; updatedOrders?: number; startedLateByMs?: number; exit: number | null; output: string }

const started: ChildProcess[] = []
export function killChildren() { for (const proc of started.splice(0)) { try { proc.kill('SIGKILL') } catch { /* gone */ } } }

export function runChild(k: Kit, label: string, orderId: string, startAt: number, extra: Record<string, string> = {}): Promise<ChildResult> {
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
      if (!line) return resolve({ label, mode: 'none', exit: code, kind: 'no_result', output })
      resolve({ ...JSON.parse(line.slice(7)), exit: code, output })
    })
  })
}

// one child, started now
export const runOne = (k: Kit, label: string, orderId: string, extra: Record<string, string> = {}) => runChild(k, label, orderId, Date.now() + 1500, extra)

// several children that start at the same wall-clock moment
export function runTogether(k: Kit, count: number, orderId: string, extra: Record<string, string> = {}) {
  const startAt = Date.now() + 2500
  return Promise.all(Array.from({ length: count }, (_, i) => runChild(k, `p${i}`, orderId, startAt, extra)))
}
