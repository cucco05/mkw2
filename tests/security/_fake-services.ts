// Local stand-ins for the outside services the production-release code talks to (step 4.6, S4): PrintLab and StockWorks.
//
// They are REAL HTTP servers on 127.0.0.1 (random port), so the application's own `fetch` code runs unchanged - timeouts, dropped connections, half-answers
// and all. NOTHING here reaches a real printer, PrintLab, StockWorks or Stripe: every test that needs them points the application at these ports.
//
// Each server counts every request it receives, and can be told how to misbehave on the call that matters (the submission / the movement):
//   ok        the job (movement) is recorded and the answer arrives
//   reject    the service refuses (4xx): it did NOT do anything
//   status    it answers with an error status (5xx, 409...), optionally AFTER having recorded the job: the caller cannot tell
//   drop      the connection is closed without any answer, optionally after having recorded the job: "response lost" / "reset after the request arrived"
//   delay     the answer comes late (after the caller gave up), optionally after recording: "timeout"
//   garbled   a 200 whose body is not JSON, optionally after recording
//   custom    the test runs its own code at the moment the request is being handled (e.g. a payment hold lands while PrintLab is busy)
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type Recorded = { method: string; path: string; body: any; at: number }

export type CallMode =
  | { kind: 'ok' }
  | { kind: 'reject'; status?: number; message?: string }
  | { kind: 'status'; status: number; record?: boolean }
  | { kind: 'drop'; record: boolean }
  | { kind: 'delay'; ms: number; record?: boolean }
  | { kind: 'garbled'; record?: boolean }
  | { kind: 'custom'; handler: (body: any, record: () => any) => Promise<void> | void }

type Server = { url: string; port: number; requests: Recorded[]; close: () => Promise<void> }

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve(null)
      try { resolve(JSON.parse(text)) } catch { resolve(text) }
    })
    req.on('error', () => resolve(null))
  })
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => Promise<void>): Promise<Server & { raw: http.Server }> {
  const requests: Recorded[] = []
  const sockets = new Set<import('node:net').Socket>()
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const path = (req.url || '').split('?')[0]
    requests.push({ method: req.method || 'GET', path, body, at: Date.now() })
    try { await handler(req, res, body) } catch (err) { json(res, 500, { error: String((err as Error)?.message || err) }) }
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    raw: server,
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

async function applyMode(mode: CallMode, res: http.ServerResponse, body: any, record: () => any, ok: (item: any) => unknown) {
  switch (mode.kind) {
    case 'ok': return json(res, 200, ok(record()))
    case 'reject': return json(res, mode.status ?? 400, { error: mode.message ?? 'refused' })
    case 'status': { if (mode.record) record(); return json(res, mode.status, { error: `status ${mode.status}` }) }
    case 'drop': { if (mode.record) record(); res.socket?.destroy(); return }
    case 'delay': {
      if (mode.record) { const item = record(); await new Promise((r) => setTimeout(r, mode.ms)); return json(res, 200, ok(item)) }
      await new Promise((r) => setTimeout(r, mode.ms)); return json(res, 200, ok(null))
    }
    case 'garbled': { if (mode.record) record(); if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('<<not json>>') } return }
    case 'custom': { await mode.handler(body, record); return json(res, 200, ok(null)) }
  }
}

// ---- PrintLab --------------------------------------------------------------------------------------------------------------------
export type FakeJob = { id: string; status: string; source_order_id: string | null; source_job_id: string | null; idempotency_key: string | null; model_id: string | null; metadata: any }
export type FakePrintLab = Server & {
  jobs: FakeJob[]
  mode: { submit: CallMode }
  options: { listJobs: boolean; honorIdempotency: boolean }
  submissions: () => Recorded[]
  calls: (method: string, path: string) => number
  otherCalls: () => Recorded[]
}

export async function startFakePrintLab(options: { listJobs?: boolean; honorIdempotency?: boolean } = {}): Promise<FakePrintLab> {
  const jobs: FakeJob[] = []
  const state = { submit: { kind: 'ok' } as CallMode }
  const opts = { listJobs: options.listJobs ?? true, honorIdempotency: options.honorIdempotency ?? false }
  let counter = 0
  const base = await listen(async (req, res, body) => {
    const path = (req.url || '').split('?')[0]
    if (req.method === 'POST' && path === '/api/works/makerworks/jobs') {
      const record = () => {
        const existing = opts.honorIdempotency && body?.idempotency_key ? jobs.find((job) => job.idempotency_key === body.idempotency_key) : null
        if (existing) return existing
        const job: FakeJob = {
          id: `pl_job_${++counter}`, status: 'queued', source_order_id: body?.source_order_id ?? null, source_job_id: body?.source_job_id ?? null,
          idempotency_key: body?.idempotency_key ?? null, model_id: body?.model_id ?? null, metadata: body?.metadata ?? null,
        }
        jobs.push(job)
        return job
      }
      return applyMode(state.submit, res, body, record, (job) => (job ? { id: job.id, status: job.status, printer_id: null, printer_name: null, queue_item_id: null } : {}))
    }
    if (req.method === 'GET' && path === '/api/jobs') {
      if (!opts.listJobs) return json(res, 404, { error: 'not found' })
      return json(res, 200, { items: jobs })
    }
    const one = path.match(/^\/api\/jobs\/([^/]+)$/)
    if (req.method === 'GET' && one) {
      const job = jobs.find((entry) => entry.id === decodeURIComponent(one[1]))
      return job ? json(res, 200, { item: job }) : json(res, 404, { error: 'not found' })
    }
    return json(res, 404, { error: 'not found' })
  })
  return {
    ...base,
    jobs,
    mode: state as any,
    options: opts,
    submissions: () => base.requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/works/makerworks/jobs'),
    calls: (method, path) => base.requests.filter((entry) => entry.method === method && entry.path === path).length,
    // anything that is not a submission or a read of jobs: a stop / pause / cancel command to a printer would show up here (it must stay empty)
    otherCalls: () => base.requests.filter((entry) => !(entry.method === 'POST' && entry.path === '/api/works/makerworks/jobs') && !(entry.method === 'GET' && entry.path.startsWith('/api/jobs'))),
  } as FakePrintLab
}

// ---- StockWorks ------------------------------------------------------------------------------------------------------------------
export type FakeMovement = { id: number; inventory_item_id: number; change_grams: number; movement_type: string; reference: string; note: string | null }
export type FakeInventoryItem = { id: number; quantity_grams: number; reorder_level: number; location: string; material: { id: number; name: string; filament_type: string; color: string } }
export type FakeStockWorks = Server & {
  movements: FakeMovement[]
  inventory: FakeInventoryItem[]
  mode: { movement: CallMode }
  options: { listMovements: boolean }
  posts: () => Recorded[]
}

export const DEFAULT_INVENTORY: FakeInventoryItem[] = [
  { id: 1, quantity_grams: 5000, reorder_level: 500, location: 'A1', material: { id: 11, name: 'PLA Black', filament_type: 'PLA', color: 'black' } },
  { id: 2, quantity_grams: 5000, reorder_level: 500, location: 'A2', material: { id: 12, name: 'PETG White', filament_type: 'PETG', color: 'white' } },
]

export async function startFakeStockWorks(options: { inventory?: FakeInventoryItem[]; listMovements?: boolean } = {}): Promise<FakeStockWorks> {
  const movements: FakeMovement[] = []
  const inventory = options.inventory ?? DEFAULT_INVENTORY
  const state = { movement: { kind: 'ok' } as CallMode }
  const opts = { listMovements: options.listMovements ?? true }
  let counter = 0
  const base = await listen(async (req, res, body) => {
    const path = (req.url || '').split('?')[0]
    if (req.method === 'GET' && path === '/inventory') return json(res, 200, { items: inventory })
    const list = path.match(/^\/inventory\/(\d+)\/movements$/)
    if (req.method === 'GET' && list) {
      if (!opts.listMovements) return json(res, 404, { error: 'not found' })
      return json(res, 200, { items: movements.filter((entry) => entry.inventory_item_id === Number(list[1])) })
    }
    if (req.method === 'POST' && path === '/movements') {
      const record = () => {
        const movement: FakeMovement = {
          id: ++counter, inventory_item_id: Number(body?.inventory_item_id), change_grams: Number(body?.change_grams),
          movement_type: String(body?.movement_type || ''), reference: String(body?.reference || ''), note: typeof body?.note === 'string' ? body.note : null,
        }
        movements.push(movement)
        return movement
      }
      return applyMode(state.movement, res, body, record, (movement) => movement ?? {})
    }
    return json(res, 404, { error: 'not found' })
  })
  return {
    ...base,
    movements,
    inventory,
    mode: state as any,
    options: opts,
    posts: () => base.requests.filter((entry) => entry.method === 'POST' && entry.path === '/movements'),
  } as FakeStockWorks
}

// Points the application at the fake servers (and only at them) for the duration of a test file; returns the restore function.
export function pointApplicationAt(services: { printLab?: FakePrintLab; stockWorks?: FakeStockWorks }, extra: Record<string, string> = {}) {
  const names = ['PRINTLAB_BASE_URL', 'BAMBU_VIEW_BASE_URL', 'PRINTLAB_API_KEY', 'MAKERWORKS_SUBMIT_API_KEY', 'STOCKWORKS_BASE_URL', 'STOCKWORKS_USERNAME', 'STOCKWORKS_ADMIN_USERNAME',
    'STOCKWORKS_PASSWORD', 'STOCKWORKS_ADMIN_PASSWORD', ...Object.keys(extra)]
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  if (services.printLab) process.env.PRINTLAB_BASE_URL = services.printLab.url
  if (services.stockWorks) {
    process.env.STOCKWORKS_BASE_URL = services.stockWorks.url
    process.env.STOCKWORKS_USERNAME = 'sectest'
    process.env.STOCKWORKS_PASSWORD = 'sectest'
  }
  Object.assign(process.env, extra)
  return () => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    }
  }
}
