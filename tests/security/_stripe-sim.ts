// A FAITHFUL stand-in for the part of Stripe the payment pages depend on, SHARED BY EVERY PROCESS of a test (DR-13, phase 1).
//
// WHY A NEW ONE. tests/security/_fake-checkout.ts lives in the memory of ONE process and is deliberately forgiving (a replay returns the same mutable object, `expire` never refuses,
// nothing is ever pruned). The questions DR-13 asks - what happens when two processes meet at the same payment page, when the answer of a call is lost, when a stored 500 is replayed,
// when a key is reused with other parameters, when `expire` and a payment race - can only be asked of something that behaves like the provider where it matters and that every process
// sees. So the state lives in PostgreSQL (schema `fakestripe` of the throw-away `*_sectest` database; Prisma never looks at that schema) and every transition is ONE atomic statement.
//
// WHAT IT FOLLOWS (provider documentation, API v1; https://docs.stripe.com/api/idempotent_requests, /api/checkout/sessions/create, /expire):
//   * `create` with an idempotency key: the status and body of the FIRST execution are saved - an error included, a 5xx included - and every later call with the same key and the same
//     parameters gets THAT back. So a replay returns a SNAPSHOT (`status: "open"`, even if the session was paid or has expired since), never the current state. Another set of
//     parameters under the same key is an idempotency error. A request that FAILED VALIDATION, and one that conflicted with a concurrent execution, saves nothing.
//   * keys are kept for at least 24 hours; after that a key may be gone and the same key makes a NEW request (`ageKey` moves a key past that horizon).
//   * `expires_at` must lie between 30 minutes and 24 hours after the creation (a violation is a validation error, not saved).
//   * `expire` works only on a session that is `open`; on a `complete` or `expired` one it is REFUSED (HTTP 400, observed in Test Mode: SP1 T2). It races with a payment atomically.
//   * a session stops being payable at its `expires_at` (it is marked `expired` lazily, when somebody looks at it, exactly as if the provider had done it at that moment).
// WHAT IT CANNOT PROVE: Stripe's real behaviour for a replay whose `expires_at` is no longer valid (`replayRevalidatesExpiresAt` plays both answers), the real network, the real timing of
// webhooks, a real card. Every result obtained with it is "possible in the model", not "verified at the provider".
//
// THE MONITOR. Every mutation of the stand-in checks, on the REAL state (not on what the application believes), that no order has more than ONE payable session, and - in the tests that
// run one request at a time - that no database transaction of the application is open while the "provider" is being called. Violations are written to `fakestripe.violation`, which
// every process can read. A scenario that LEGITIMATELY starts from a bad state (twins made by the old code) says so with `seedSession({ legacy: true })`; the monitor never hides a
// violation by being switched off for the rest of the scenario.
import { createHash } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { installFakeStripe } from './_harness'
import './_clock' // the process clock a test can move: everything below that is about time reads Date.now(), never the database clock

export const MIN_EXPIRY_MS = 30 * 60_000
export const MAX_EXPIRY_MS = 24 * 3_600_000
export const KEY_RETENTION_MS = 24 * 3_600_000

type Json = Record<string, any>

// ---- errors in the shapes stripe-node produces (type = class name, rawType = the API's own) ----------------------------------------------------------------------------
export function simError(kind:
  'connection' | 'api500' | 'rate_limit' | 'key_in_use' | 'validation' | 'idempotency' | 'missing' | 'expire_refused' | 'auth', extra: Json = {}) {
  const base: Record<string, Json> = {
    connection: { type: 'StripeConnectionError', message: 'An error occurred with our connection to Stripe. Request was retried 2 times.' },
    api500: { type: 'StripeAPIError', rawType: 'api_error', statusCode: 500, message: 'An unknown error occurred' },
    rate_limit: { type: 'StripeRateLimitError', rawType: 'rate_limit_error', statusCode: 429, code: 'rate_limit', message: 'Too many requests' },
    key_in_use: { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 409, code: 'idempotency_key_in_use', message: 'There is currently another in-progress request using this Stripe idempotency key.' },
    validation: { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 400, code: 'parameter_invalid_integer', message: 'Invalid parameter' },
    idempotency: { type: 'StripeIdempotencyError', rawType: 'idempotency_error', statusCode: 400, message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' },
    missing: { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 404, code: 'resource_missing', message: 'No such checkout.session' },
    expire_refused: { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 400, message: "Only Checkout Sessions with a status in ['open'] can be expired." },
    auth: { type: 'StripeAuthenticationError', rawType: 'authentication_error', statusCode: 401, message: 'Invalid API Key provided' },
  }
  return Object.assign(new Error(String(extra.message ?? base[kind].message)), { requestId: `req_SIM_${Math.random().toString(36).slice(2, 10)}`, ...base[kind], ...extra }) as SimError
}
export type SimError = Error & { type: string; rawType?: string; statusCode?: number; code?: string; param?: string; requestId: string }

// canonical form of a set of parameters: keys sorted, `undefined` dropped (what two requests "with the same parameters" means to the stand-in)
export function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonical(value[key])
    return out
  }
  return value
}
export const paramsHash = (params: unknown) => createHash('sha256').update(JSON.stringify(canonical(params))).digest('hex')

export type SimFaults = {
  // --- before the provider executes anything: nothing is created, nothing is saved
  createUnreachable: number          // the request never arrives (connection refused / DNS): StripeConnectionError
  createRateLimited: number          // 429: rejected before execution
  createKeyInUse: number             // 409 idempotency_key_in_use
  createInvalid: number              // a validation error (400 invalid_request_error): not saved
  // --- the provider EXECUTES (a session exists) and the caller does not get the answer it should
  createLostAnswer: number           // the session is created and the result saved, the caller sees a connection error
  createStored500Created: number     // execution began, the session was created, the saved result is a 500
  createStored500NotCreated: number  // execution began, nothing was created, the saved result is a 500
  createCrashAfter: number           // (child processes) the process dies right after the provider created the session
  createCrashBefore: number          // (child processes) the process dies as the call starts, before anything happens at the provider
  createDelayMs: number              // milliseconds the execution takes (sticky until set back to 0)
  delayFirstCreateOnly: boolean      // apply createDelayMs to ONE create only
  retrieveUnreachable: number
  retrieveInconclusive: number       // the read answers `open` for a session that is not (a stale replica): models "retrieve is inconclusive"
  expireUnreachable: number          // the call never arrives: the session stays as it was
  expireLostAnswer: number           // the session IS expired, the caller sees a connection error
  expireStored500: number            // 5xx without effect
  expireCrashAfter: number
}
export const NO_FAULTS = (): SimFaults => ({
  createUnreachable: 0, createRateLimited: 0, createKeyInUse: 0, createInvalid: 0, createLostAnswer: 0, createStored500Created: 0, createStored500NotCreated: 0, createCrashAfter: 0, createCrashBefore: 0,
  createDelayMs: 0, delayFirstCreateOnly: false, retrieveUnreachable: 0, retrieveInconclusive: 0, expireUnreachable: 0, expireLostAnswer: 0, expireStored500: 0, expireCrashAfter: 0,
})

export type SimHooks = {
  // runs inside `create`, AFTER the session exists at the provider and BEFORE the caller gets the answer: this is where the customer pays, or the order is paid, "while Stripe is being called"
  duringCreate?: (session: Json) => Promise<void>
  // runs inside `expire`, BEFORE the provider executes it
  duringExpire?: (sessionId: string) => Promise<void>
  // runs inside `expire`, AFTER the provider closed the session and BEFORE the caller gets the answer: where the provider's own announcement (the webhook) can overtake the caller
  afterExpire?: (sessionId: string) => Promise<void>
  // runs as `create` is entered, before anything
  beforeCreate?: (params: Json, options: Json) => Promise<void>
  // runs as `retrieve` is entered
  beforeRetrieve?: (id: string, params?: Json) => Promise<void>
}

export type SimOptions = {
  // true: a replay with an `expires_at` that would not be valid for a NEW request is rejected by the provider (the pessimistic answer to the open question A3);
  // false: it returns the saved result (the optimistic answer). The code under test must be safe with BOTH.
  replayRevalidatesExpiresAt: boolean
  // what a request that meets the SAME key still being executed gets: wait for the result, or the 409 `idempotency_key_in_use`
  inflight: 'wait' | '409'
  // only for tests that make ONE request at a time: record a violation if a database transaction of the application is open while the provider is called
  probeTransactions: boolean
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class StripeSim {
  private client: PrismaClient
  faults: SimFaults = NO_FAULTS()
  hooks: SimHooks = {}
  options: SimOptions = { replayRevalidatesExpiresAt: false, inflight: 'wait', probeTransactions: false }
  private firstCreateDelayed = false

  constructor(url = process.env.SEC_TEST_DATABASE_URL as string) {
    // a pool of its own: the application's pool is never the thing the stand-in competes for
    const withPool = url.includes('?') ? `${url}&connection_limit=8&pool_timeout=30` : `${url}?connection_limit=8&pool_timeout=30`
    this.client = new PrismaClient({ datasources: { db: { url: withPool } }, log: [] })
  }

  async close() { await this.client.$disconnect() }

  // ---- schema ---------------------------------------------------------------------------------------------------------------------------------------------------
  async ensureSchema() {
    const sql = [
      `CREATE SCHEMA IF NOT EXISTS fakestripe`,
      `CREATE SEQUENCE IF NOT EXISTS fakestripe.session_seq`,
      `CREATE SEQUENCE IF NOT EXISTS fakestripe.intent_seq`,
      `CREATE TABLE IF NOT EXISTS fakestripe.session (
         id text PRIMARY KEY, seq bigint NOT NULL, order_id text, attempt_id text, status text NOT NULL, payment_status text NOT NULL DEFAULT 'unpaid',
         expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), payment_intent text, body jsonb NOT NULL, idem_key text, legacy boolean NOT NULL DEFAULT false)`,
      `CREATE TABLE IF NOT EXISTS fakestripe.idem (
         key text PRIMARY KEY, params_hash text NOT NULL, state text NOT NULL, result_kind text, result jsonb, session_id text,
         recorded_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
      `CREATE TABLE IF NOT EXISTS fakestripe.intent (id text PRIMARY KEY, body jsonb NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS fakestripe.oplog (seq bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(), pid int NOT NULL, op text NOT NULL, detail jsonb)`,
      `CREATE TABLE IF NOT EXISTS fakestripe.violation (seq bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(), pid int NOT NULL, kind text NOT NULL, detail jsonb)`,
      `CREATE TABLE IF NOT EXISTS fakestripe.delivery (seq bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(), order_id text, session_id text, via text)`,
    ]
    for (const statement of sql) await this.client.$executeRawUnsafe(statement)
  }

  async reset() {
    await this.client.$executeRawUnsafe(`TRUNCATE fakestripe.session, fakestripe.idem, fakestripe.intent, fakestripe.oplog, fakestripe.violation, fakestripe.delivery RESTART IDENTITY`)
    this.faults = NO_FAULTS()
    this.hooks = {}
    this.options = { replayRevalidatesExpiresAt: false, inflight: 'wait', probeTransactions: false }
    this.firstCreateDelayed = false
  }

  // faults and options for a CHILD process come in the environment (SIM_FAULTS, SIM_OPTIONS) so that one test configures every process the same way
  configureFromEnv() {
    if (process.env.SIM_FAULTS) Object.assign(this.faults, JSON.parse(process.env.SIM_FAULTS))
    if (process.env.SIM_OPTIONS) Object.assign(this.options, JSON.parse(process.env.SIM_OPTIONS))
  }

  // ---- logging and the monitor ----------------------------------------------------------------------------------------------------------------------------------
  async op(op: string, detail: Json = {}) {
    await this.client.$executeRawUnsafe(`INSERT INTO fakestripe.oplog (pid, op, detail) VALUES ($1, $2, $3::jsonb)`, process.pid, op, JSON.stringify(detail))
  }
  async violation(kind: string, detail: Json) {
    await this.client.$executeRawUnsafe(`INSERT INTO fakestripe.violation (pid, kind, detail) VALUES ($1, $2, $3::jsonb)`, process.pid, kind, JSON.stringify(detail))
  }
  // the monitor: on the REAL state, no order has more than one payable session
  private async checkPayable(orderId: string | null, cause: string) {
    if (!orderId) return
    const rows: Array<{ id: string }> = await this.client.$queryRawUnsafe(
      `SELECT id FROM fakestripe.session WHERE order_id = $1 AND status = 'open' AND expires_at > to_timestamp($2::double precision / 1000.0) AND legacy = false ORDER BY seq`, orderId, Date.now())
    const legacy: Array<{ id: string }> = await this.client.$queryRawUnsafe(
      `SELECT id FROM fakestripe.session WHERE order_id = $1 AND status = 'open' AND expires_at > to_timestamp($2::double precision / 1000.0) AND legacy = true ORDER BY seq`, orderId, Date.now())
    if (rows.length + legacy.length > 1 && rows.length > 0) await this.violation('payable_gt_1', { orderId, cause, payable: [...legacy, ...rows].map((row) => row.id) })
  }
  // proof that no database transaction of the application is open while the "provider" is being called (meaningful only when one request runs at a time)
  private async probeTransactions(op: string) {
    if (!this.options.probeTransactions) return
    const rows: Array<{ n: number }> = await this.client.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`)
    if ((rows[0]?.n ?? 0) > 0) await this.violation('transaction_open_during_provider_call', { op, open: rows[0].n })
  }

  // ---- reading the state (the monitor's view, for the tests) ------------------------------------------------------------------------------------------------------
  async oplog(): Promise<Array<{ seq: number; op: string; detail: Json; pid: number }>> {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT seq::int, op, detail, pid FROM fakestripe.oplog ORDER BY seq`)
    return rows
  }
  async violations(): Promise<Array<{ kind: string; detail: Json }>> {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT kind, detail FROM fakestripe.violation ORDER BY seq`)
    return rows
  }
  async sessionsOf(orderId: string): Promise<Array<{ id: string; status: string; paymentStatus: string; attemptId: string | null; expiresInS: number; legacy: boolean; paymentIntent: string | null }>> {
    const rows: any[] = await this.client.$queryRawUnsafe(
      `SELECT id, status, payment_status, attempt_id, round(extract(epoch FROM (expires_at - to_timestamp($2::double precision / 1000.0))))::int AS exp, legacy, payment_intent FROM fakestripe.session WHERE order_id = $1 ORDER BY seq`, orderId, Date.now())
    return rows.map((row) => ({ id: row.id, status: row.status, paymentStatus: row.payment_status, attemptId: row.attempt_id, expiresInS: row.exp, legacy: row.legacy, paymentIntent: row.payment_intent }))
  }
  // payable = what the provider's page would accept right now
  async payable(orderId: string): Promise<string[]> {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT id FROM fakestripe.session WHERE order_id = $1 AND status = 'open' AND expires_at > to_timestamp($2::double precision / 1000.0) ORDER BY seq`, orderId, Date.now())
    return rows.map((row) => row.id)
  }
  async orderOfSession(sessionId: string): Promise<string | null> {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT order_id FROM fakestripe.session WHERE id = $1`, sessionId)
    return rows[0]?.order_id ?? null
  }
  async countOps(op: string): Promise<number> {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT count(*)::int AS n FROM fakestripe.oplog WHERE op = $1`, op)
    return rows[0]?.n ?? 0
  }
  async createdSessions(): Promise<number> {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT count(*)::int AS n FROM fakestripe.session`)
    return rows[0]?.n ?? 0
  }
  async recordDelivery(orderId: string, sessionId: string, via: string) {
    await this.client.$executeRawUnsafe(`INSERT INTO fakestripe.delivery (order_id, session_id, via) VALUES ($1, $2, $3)`, orderId, sessionId, via)
  }
  async deliveries(orderId: string): Promise<string[]> {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT DISTINCT session_id FROM fakestripe.delivery WHERE order_id = $1`, orderId)
    return rows.map((row) => row.session_id)
  }

  // ---- time (the stand-in runs on the process clock, which a test can move: tests/security/_clock.ts; it never reads the database clock for anything a test can move) -------------
  async expiresIn(sessionId: string, ms: number) {
    await this.client.$executeRawUnsafe(`UPDATE fakestripe.session SET expires_at = to_timestamp(($2::double precision + $3::double precision) / 1000.0) WHERE id = $1`, sessionId, Date.now(), ms)
  }
  // moves a key past (or back from) the retention horizon without moving the clock: the provider may have forgotten it
  async ageKey(key: string, ms: number) {
    await this.client.$executeRawUnsafe(`UPDATE fakestripe.idem SET recorded_at = to_timestamp(($2::double precision - $3::double precision) / 1000.0) WHERE key = $1`, key, Date.now(), ms)
  }
  async forgetKey(key: string) { await this.client.$executeRawUnsafe(`DELETE FROM fakestripe.idem WHERE key = $1`, key) }

  // ---- building objects ---------------------------------------------------------------------------------------------------------------------------------------------
  private body(id: string, params: Json): Json {
    const amount = (params.line_items || []).reduce((sum: number, line: any) => sum + (line.price_data?.unit_amount ?? 0) * (line.quantity ?? 1), 0)
    return {
      id, object: 'checkout.session', livemode: false, mode: params.mode, status: 'open', payment_status: 'unpaid', url: `https://checkout.stripe.test/c/pay/${id}`,
      amount_total: amount, currency: params.line_items?.[0]?.price_data?.currency, client_reference_id: params.client_reference_id ?? null, metadata: params.metadata ?? {},
      payment_method_types: params.payment_method_types, expires_at: params.expires_at, payment_intent: null, customer_email: params.customer_email ?? null,
    }
  }
  private async rowObject(row: any, expand: string[] = []): Promise<Json> {
    const out = { ...row.body, status: row.status, payment_status: row.payment_status, expires_at: Math.floor(new Date(row.expires_at).getTime() / 1000) }
    if (row.status !== 'open') out.url = null
    if (row.customer_details) out.customer_details = row.customer_details
    if (row.collected_information) out.collected_information = row.collected_information
    if (row.payment_intent) {
      if (expand.some((entry) => entry.startsWith('payment_intent'))) {
        const piRows: any[] = await this.client.$queryRawUnsafe(`SELECT body FROM fakestripe.intent WHERE id = $1`, row.payment_intent)
        const pi = piRows[0]?.body
        out.payment_intent = pi ? (expand.includes('payment_intent.latest_charge') ? pi : { ...pi, latest_charge: pi.latest_charge?.id ?? null }) : row.payment_intent
      } else out.payment_intent = row.payment_intent
    }
    return out
  }
  private async lazyExpire(id: string) {
    await this.client.$executeRawUnsafe(`UPDATE fakestripe.session SET status = 'expired' WHERE id = $1 AND status = 'open' AND expires_at <= to_timestamp($2::double precision / 1000.0)`, id, Date.now())
  }
  private async row(id: string): Promise<any | null> {
    await this.lazyExpire(id)
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT * FROM fakestripe.session WHERE id = $1`, id)
    return rows[0] ?? null
  }

  // ---- the operations the application uses ------------------------------------------------------------------------------------------------------------------------
  private validate(params: Json) {
    const expiresMs = Number(params.expires_at) * 1000
    const ahead = expiresMs - Date.now()
    if (params.expires_at !== undefined && (ahead < MIN_EXPIRY_MS || ahead > MAX_EXPIRY_MS)) {
      throw simError('validation', { code: 'parameter_invalid_integer', param: 'expires_at', message: 'The `expires_at` timestamp must be between 30 minutes and 24 hours from now.' })
    }
    for (const line of params.line_items || []) {
      if (!Number.isInteger(line.price_data?.unit_amount) || line.price_data.unit_amount < 0) throw simError('validation', { param: 'line_items[0][price_data][unit_amount]' })
    }
  }

  async create(params: Json, options: Json = {}): Promise<Json> {
    await this.op('create.call', { key: options.idempotencyKey ?? null })
    await this.hooks.beforeCreate?.(params, options)
    if (this.faults.createCrashBefore > 0) { this.faults.createCrashBefore--; await this.op('crash.before_create'); process.exit(137) }
    await this.probeTransactions('create')
    if (this.faults.createUnreachable > 0) { this.faults.createUnreachable--; await this.op('create.unreachable'); throw simError('connection') }
    if (this.faults.createRateLimited > 0) { this.faults.createRateLimited--; await this.op('create.429'); throw simError('rate_limit') }
    if (this.faults.createKeyInUse > 0) { this.faults.createKeyInUse--; await this.op('create.409'); throw simError('key_in_use') }
    if (this.faults.createInvalid > 0) { this.faults.createInvalid--; await this.op('create.invalid'); throw simError('validation', { param: 'success_url' }) }

    const key: string | null = options.idempotencyKey ?? null
    const hash = paramsHash(params)
    let owned = false
    if (key) {
      for (let guard = 0; guard < 6 && !owned; guard++) {
        const claim: any[] = await this.client.$queryRawUnsafe(
          `INSERT INTO fakestripe.idem (key, params_hash, state, recorded_at) VALUES ($1, $2, 'running', to_timestamp($3::double precision / 1000.0)) ON CONFLICT (key) DO NOTHING RETURNING key`, key, hash, Date.now())
        if (claim.length > 0) { owned = true; break }
        const found: any[] = await this.client.$queryRawUnsafe(
          `SELECT key, params_hash, state, result_kind, result, session_id, (recorded_at < to_timestamp(($2::double precision - $3::double precision) / 1000.0)) AS pruned FROM fakestripe.idem WHERE key = $1`, key, Date.now(), KEY_RETENTION_MS)
        const existing = found[0]
        if (!existing) continue // vanished between the two statements: claim again
        if (existing.pruned) { await this.client.$executeRawUnsafe(`DELETE FROM fakestripe.idem WHERE key = $1`, key); await this.op('create.key_pruned', { key }); continue }
        if (existing.params_hash !== hash) { await this.op('create.idempotency_error', { key }); throw simError('idempotency') }
        if (existing.state === 'running') {
          if (this.options.inflight === '409') { await this.op('create.409_in_flight', { key }); throw simError('key_in_use') }
          for (let waited = 0; waited < 20_000; waited += 25) {
            await sleep(25)
            const again: any[] = await this.client.$queryRawUnsafe(`SELECT state, result_kind, result FROM fakestripe.idem WHERE key = $1`, key)
            if (!again[0]) break // the first execution failed before saving anything (validation): this call goes on as a new request
            if (again[0].state === 'done') { existing.state = 'done'; existing.result_kind = again[0].result_kind; existing.result = again[0].result; break }
          }
          if (existing.state !== 'done') continue
        }
        // a saved result: the first response, whatever it was
        if (this.options.replayRevalidatesExpiresAt && existing.result_kind === 'ok') {
          const ahead = Number(params.expires_at) * 1000 - Date.now()
          if (ahead < MIN_EXPIRY_MS) { await this.op('create.replay_rejected_expires_at', { key }); throw simError('validation', { param: 'expires_at', message: 'The `expires_at` timestamp must be between 30 minutes and 24 hours from now.' }) }
        }
        await this.op('create.replay', { key, kind: existing.result_kind, sessionId: existing.result?.id ?? null })
        if (existing.result_kind === 'ok') return JSON.parse(JSON.stringify(existing.result))
        throw Object.assign(new Error(existing.result.message), existing.result)
      }
      if (!owned) throw simError('api500', { message: 'the stand-in could not settle the idempotency key' })
    }
    try {
      // validation happens BEFORE execution: a request that fails it saves nothing (the claim above is released)
      this.validate(params)
    } catch (error) {
      if (key) await this.client.$executeRawUnsafe(`DELETE FROM fakestripe.idem WHERE key = $1 AND state = 'running'`, key)
      await this.op('create.validation_failed', { key, param: (error as any).param })
      throw error
    }

    // EXECUTION
    const delay = this.faults.createDelayMs
    if (delay > 0 && !(this.faults.delayFirstCreateOnly && this.firstCreateDelayed)) { this.firstCreateDelayed = true; await sleep(delay) }
    const stored500NotCreated = this.faults.createStored500NotCreated > 0 && (this.faults.createStored500NotCreated--, true)
    if (stored500NotCreated) {
      const err = simError('api500')
      await this.finishKey(key, 'error', { type: err.type, rawType: (err as any).rawType, statusCode: 500, message: err.message }, null)
      await this.op('create.stored_500_not_created', { key })
      throw err
    }
    const seq: any[] = await this.client.$queryRawUnsafe(`SELECT nextval('fakestripe.session_seq')::int AS n`)
    const id = `cs_test_SIM_${String(seq[0].n).padStart(6, '0')}`
    const body = this.body(id, params)
    await this.client.$executeRawUnsafe(
      `INSERT INTO fakestripe.session (id, seq, order_id, attempt_id, status, payment_status, expires_at, body, idem_key, created_at) VALUES ($1, $2, $3, $4, 'open', 'unpaid', to_timestamp($5), $6::jsonb, $7, to_timestamp($8::double precision / 1000.0))`,
      id, seq[0].n, params.client_reference_id ?? null, params.metadata?.attemptId ?? null, Number(params.expires_at), JSON.stringify(body), key, Date.now())
    await this.op('create.executed', { key, sessionId: id, orderId: params.client_reference_id ?? null })
    await this.checkPayable(params.client_reference_id ?? null, `create ${id}`)
    await this.hooks.duringCreate?.({ ...body })

    if (this.faults.createStored500Created > 0) {
      this.faults.createStored500Created--
      const err = simError('api500')
      await this.finishKey(key, 'error', { type: err.type, rawType: (err as any).rawType, statusCode: 500, message: err.message }, id)
      await this.op('create.stored_500_created', { key, sessionId: id })
      throw err
    }
    await this.finishKey(key, 'ok', body, id)
    if (this.faults.createLostAnswer > 0) { this.faults.createLostAnswer--; await this.op('create.answer_lost', { key, sessionId: id }); throw simError('connection') }
    if (this.faults.createCrashAfter > 0) { this.faults.createCrashAfter--; await this.op('crash.after_create', { key, sessionId: id }); process.exit(137) }
    return JSON.parse(JSON.stringify(body))
  }

  private async finishKey(key: string | null, kind: 'ok' | 'error', result: Json, sessionId: string | null) {
    if (!key) return
    await this.client.$executeRawUnsafe(`UPDATE fakestripe.idem SET state = 'done', result_kind = $2, result = $3::jsonb, session_id = $4 WHERE key = $1`, key, kind, JSON.stringify(result), sessionId)
  }

  async retrieve(id: string, params: Json = {}): Promise<Json> {
    await this.hooks.beforeRetrieve?.(id, params)
    await this.op('retrieve', { id })
    await this.probeTransactions('retrieve')
    if (this.faults.retrieveUnreachable > 0) { this.faults.retrieveUnreachable--; throw simError('connection') }
    const row = await this.row(id)
    if (!row) throw simError('missing')
    if (this.faults.retrieveInconclusive > 0 && row.status !== 'open') { this.faults.retrieveInconclusive--; return this.rowObject({ ...row, status: 'open' }, params.expand || []) }
    return this.rowObject(row, params.expand || [])
  }

  async expire(id: string): Promise<Json> {
    await this.op('expire.call', { id })
    await this.probeTransactions('expire')
    await this.hooks.duringExpire?.(id)
    if (this.faults.expireUnreachable > 0) { this.faults.expireUnreachable--; await this.op('expire.unreachable', { id }); throw simError('connection') }
    if (this.faults.expireStored500 > 0) { this.faults.expireStored500--; await this.op('expire.500', { id }); throw simError('api500') }
    await this.lazyExpire(id)
    const done: any[] = await this.client.$queryRawUnsafe(`UPDATE fakestripe.session SET status = 'expired' WHERE id = $1 AND status = 'open' RETURNING *`, id)
    if (done.length === 0) {
      const row = await this.row(id)
      if (!row) throw simError('missing')
      await this.op('expire.refused', { id, status: row.status })
      throw simError('expire_refused')
    }
    await this.op('expire.executed', { id })
    await this.hooks.afterExpire?.(id)
    if (this.faults.expireLostAnswer > 0) { this.faults.expireLostAnswer--; throw simError('connection') }
    if (this.faults.expireCrashAfter > 0) { this.faults.expireCrashAfter--; await this.op('crash.after_expire', { id }); process.exit(137) }
    return this.rowObject(done[0])
  }

  async retrieveIntent(id: string, params: Json = {}): Promise<Json> {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT body FROM fakestripe.intent WHERE id = $1`, id)
    if (!rows[0]) throw simError('missing', { message: 'No such payment_intent' })
    const pi = rows[0].body
    return params.expand?.includes('latest_charge') ? pi : { ...pi, latest_charge: pi.latest_charge?.id ?? null }
  }

  // ---- the customer and the operator ------------------------------------------------------------------------------------------------------------------------------
  // The customer pays the page. ATOMIC with `expire` and with the page's own expiry: it works only if the session is open and not past its `expires_at`.
  async pay(id: string, over: { amount?: number; currency?: string; piStatus?: string; email?: string | null } = {}): Promise<{ paid: boolean; piId?: string }> {
    const piSeq: any[] = await this.client.$queryRawUnsafe(`SELECT nextval('fakestripe.intent_seq')::int AS n`)
    const piId = `pi_test_SIM_${piSeq[0].n}`
    await this.lazyExpire(id)
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT body FROM fakestripe.session WHERE id = $1`, id)
    if (!rows[0]) throw simError('missing')
    const body = rows[0].body
    const amount = over.amount ?? body.amount_total
    const piStatus = over.piStatus ?? 'succeeded'
    const pi = {
      id: piId, object: 'payment_intent', status: piStatus, amount, amount_received: piStatus === 'succeeded' ? amount : 0, currency: over.currency ?? body.currency,
      metadata: { ...body.metadata }, customer: null,
      latest_charge: { id: `ch_SIM_${piSeq[0].n}`, receipt_url: 'https://pay.stripe.test/receipt', amount_refunded: 0, disputed: false, paid: true, status: 'succeeded' },
    }
    const details = { email: over.email === undefined ? 'buyer@example.test' : over.email, name: 'Mario Rossi' }
    const collected = { shipping_details: { name: 'Mario Rossi', address: { line1: 'Via Roma 1', line2: null, city: 'Milano', state: 'MI', postal_code: '20100', country: 'IT' } } }
    const done: any[] = await this.client.$queryRawUnsafe(
      `UPDATE fakestripe.session SET status = 'complete', payment_status = $2, payment_intent = $3, body = body || $4::jsonb
       WHERE id = $1 AND status = 'open' AND expires_at > to_timestamp($5::double precision / 1000.0) RETURNING id`,
      id, piStatus === 'succeeded' ? 'paid' : 'unpaid', piId, JSON.stringify({ customer_details: details, collected_information: collected }), Date.now())
    if (done.length === 0) { await this.op('pay.refused', { id }); return { paid: false } }
    await this.client.$executeRawUnsafe(`INSERT INTO fakestripe.intent (id, body) VALUES ($1, $2::jsonb)`, piId, JSON.stringify(pi))
    await this.op('pay.executed', { id, piId })
    return { paid: true, piId }
  }

  // A session that already exists when a scenario starts: what the OLD code left behind (twins, orphans), or a reservation whose answer was lost. `legacy: true` tells the monitor that
  // the bad state is the scenario's PREMISE, not a violation made during it.
  async seedSession(input: { orderId: string; attemptId: string | null; expiresInMs?: number; key?: string; params?: Json; legacy?: boolean; status?: 'open' | 'complete' | 'expired'; amount?: number; currency?: string; metadataOrderId?: string | null }): Promise<string> {
    const seq: any[] = await this.client.$queryRawUnsafe(`SELECT nextval('fakestripe.session_seq')::int AS n`)
    const id = `cs_test_SIM_${String(seq[0].n).padStart(6, '0')}`
    const expiresMs = Date.now() + (input.expiresInMs ?? 32 * 60_000)
    const params = input.params ?? {
      mode: 'payment', client_reference_id: input.orderId, metadata: { orderId: input.metadataOrderId ?? input.orderId, attemptId: input.attemptId }, payment_method_types: ['card'],
      line_items: [{ quantity: 1, price_data: { currency: input.currency ?? 'eur', unit_amount: input.amount ?? 1000 } }], expires_at: Math.floor(expiresMs / 1000),
    }
    const body = this.body(id, { ...params, metadata: params.metadata ?? { orderId: input.orderId, attemptId: input.attemptId }, client_reference_id: params.client_reference_id ?? input.orderId })
    await this.client.$executeRawUnsafe(
      `INSERT INTO fakestripe.session (id, seq, order_id, attempt_id, status, payment_status, expires_at, body, idem_key, legacy) VALUES ($1, $2, $3, $4, $5, 'unpaid', to_timestamp($6), $7::jsonb, $8, $9)`,
      id, seq[0].n, input.orderId, input.attemptId, input.status ?? 'open', expiresMs / 1000, JSON.stringify(body), input.key ?? null, input.legacy ?? false)
    if (input.key) {
      await this.client.$executeRawUnsafe(`INSERT INTO fakestripe.idem (key, params_hash, state, result_kind, result, session_id) VALUES ($1, $2, 'done', 'ok', $3::jsonb, $4) ON CONFLICT (key) DO NOTHING`,
        input.key, paramsHash(params), JSON.stringify(body), id)
    }
    await this.op('seed', { id, legacy: input.legacy ?? false })
    if (!input.legacy) await this.checkPayable(input.orderId, `seed ${id}`)
    return id
  }

  // A PaymentIntent that exists at the provider while the page it was made for is NOT paid: a payment that was cancelled (an operator, or the end of the customer's attempt) whereas the Checkout
  // session itself is still `open`. The application learns of it from an event and reads it with `paymentIntents.retrieve`.
  async seedIntent(input: { orderId: string; attemptId: string | null; status: 'canceled' | 'requires_payment_method' | 'requires_action'; amount?: number; currency?: string }): Promise<string> {
    const seq: any[] = await this.client.$queryRawUnsafe(`SELECT nextval('fakestripe.intent_seq')::int AS n`)
    const id = `pi_test_SIM_${seq[0].n}`
    const pi = { id, object: 'payment_intent', status: input.status, amount: input.amount ?? 1000, amount_received: 0, currency: input.currency ?? 'eur', metadata: { orderId: input.orderId, attemptId: input.attemptId }, customer: null, latest_charge: null }
    await this.client.$executeRawUnsafe(`INSERT INTO fakestripe.intent (id, body) VALUES ($1, $2::jsonb)`, id, JSON.stringify(pi))
    await this.op('seed.intent', { id, status: input.status })
    return id
  }

  // The events Stripe would send for a session (the payload is only a HINT to the application; it never carries the state it trusts)
  async sessionEvent(type: 'checkout.session.completed' | 'checkout.session.expired', sessionId: string, eventId?: string) {
    const rows: any[] = await this.client.$queryRawUnsafe(`SELECT body, payment_intent FROM fakestripe.session WHERE id = $1`, sessionId)
    const body = rows[0]?.body ?? {}
    return {
      id: eventId ?? `evt_SIM_${Math.random().toString(36).slice(2, 12)}`, object: 'event', type, livemode: false,
      data: { object: { id: sessionId, object: 'checkout.session', metadata: body.metadata ?? {}, payment_intent: rows[0]?.payment_intent ?? null } },
    }
  }

  // ---- wiring it into the application's Stripe client -------------------------------------------------------------------------------------------------------------
  async install() {
    await this.ensureSchema()
    this.configureFromEnv()
    return installFakeStripe({
      'checkout.sessions.create': (params: Json, options: Json) => this.create(params, options),
      'checkout.sessions.retrieve': (id: string, params?: Json) => this.retrieve(id, params),
      'checkout.sessions.expire': (id: string) => this.expire(id),
      'paymentIntents.retrieve': (id: string, params?: Json) => this.retrieveIntent(id, params),
    })
  }
}
