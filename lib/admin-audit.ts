// The administrators' audit log: an append-only HASH CHAIN (see lib/admin-audit-chain.ts for the rules and the reasons - the pure part, tested over every combination).
//
// HOW AN EVENT IS WRITTEN. Everything that decides what the new event is - which event it continues, which instant it carries, what its hash covers - happens while ONE lock is held, inside ONE
// transaction, from before the tail is read until the event is stored:
//   1. the administrator is read (their e-mail and name are part of the event);
//   2. `pg_advisory_xact_lock` is taken: one writer at a time, for the whole log;
//   3. the helper CHECKS, in the database, that the lock is held by this very transaction and that the transaction reads committed data - an ordinary client with no transaction would have lost
//      the lock when its statement ended, and a transaction that reads an older snapshot would not see the event the previous writer just stored. Either is refused (AdminAuditError), loudly,
//      before anything is written;
//   4. the newest events are read, the tail to continue is chosen (not by the clock alone, and followed past the window when the line goes on there), the instant is taken NOW - after the lock - and never earlier than the newest event plus a millisecond,
//      the hash is computed and the event stored.
//
// THE TWO WAYS TO CALL IT (the choice is made by the caller, in the call - it is not guessed from the client that was handed over):
//   recordAdminAuditEventInTransaction(tx, input)   JOINS the caller's transaction and never opens another: the operation and its audit event are ONE unit - both are committed, or neither -
//                                                   and the chain lock is held until the caller's transaction ends. Use it when the audit event must not exist without the operation (or the
//                                                   operation without it). The caller writes the audit event LAST in its transaction: the chain lock is then the last lock it takes, which is
//                                                   what keeps the order of locks (row locks first, chain lock last) the same for everybody.
//   recordAdminAuditEventStandalone(input)          opens a SHORT transaction of its own (administrator, lock, tail, insert) and holds the lock only for it. The chain stays whole; the
//                                                   operation the caller did before is NOT part of it: if the process dies between the two, the operation is done and has no event. A caller that
//                                                   needs both or neither must hand over its transaction instead.
//   recordAdminAuditEvent(input, tx?)               the call every route has always made: with a transaction it is the first, without it the second. Nothing is inferred - an argument that is
//                                                   not a transaction is refused by the lock check above (and by the type: a PrismaClient does not fit `AuditTransactionClient`).
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { resolveClientIp } from '@/lib/client-ip'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'
import {
  AUDIT_CLOCK_BEHIND_ALARM_MS, AUDIT_TAIL_WINDOW, AuditTailUnresolvedError, analyzeAuditChain, auditEventHash, chooseAuditTail, nextAuditTimestamp, storedAuditMetadata,
  type AuditChainEvent, type AuditChainReport,
} from '@/lib/admin-audit-chain'

const ADMIN_AUDIT_CHAIN_LOCK = 98234721
// A writer queued behind the lock waits for the transactions that came before it (each is short, but a caller's own transaction can hold the lock until it ends): long enough that waiting is
// never what fails the event, short enough that a stuck holder is noticed.
const STANDALONE_TRANSACTION = { maxWait: 10_000, timeout: 30_000 } as const

export type AdminAuditInput = {
  adminId: string
  action: string
  targetType?: string | null
  targetId?: string | null
  requestMethod: string
  requestPath: string
  requestIp?: string | null
  userAgent?: string | null
  metadata?: Prisma.InputJsonValue
}

// The client of a transaction - never the ordinary client (which has `$transaction`; this type says it must not).
export type AuditTransactionClient = Prisma.TransactionClient & { $transaction?: never }

export type AdminAuditRecord = { id: string; eventHash: string; prevHash: string | null; createdAt: Date }

export type AdminAuditErrorCode = 'AUDIT_NOT_IN_TRANSACTION' | 'AUDIT_ISOLATION_UNSUPPORTED' | 'AUDIT_ACTOR_NOT_FOUND' | 'AUDIT_TAIL_UNRESOLVED'
export class AdminAuditError extends Error {
  readonly code: AdminAuditErrorCode
  constructor(code: AdminAuditErrorCode, message: string) {
    super(message)
    this.name = 'AdminAuditError'
    this.code = code
  }
}

export function getAdminAuditRequestMeta(req: Request) {
  const url = new URL(req.url)
  return {
    requestMethod: req.method,
    requestPath: url.pathname,
    requestIp: resolveClientIp(req.headers),
    userAgent: (req.headers.get('user-agent') || '').trim().slice(0, 512) || null,
  }
}

// The lock was just asked for. Is it held - by the backend that runs the next statement - and does that statement read committed data? (Asked of the database itself, not of the shape of the
// client object: the answer is the same whatever the client is.)
async function assertChainLockHeld(tx: Prisma.TransactionClient) {
  const high = Math.floor(ADMIN_AUDIT_CHAIN_LOCK / 2 ** 32)
  const low = ADMIN_AUDIT_CHAIN_LOCK % 2 ** 32
  const rows = await tx.$queryRaw<Array<{ held: boolean; isolation: string }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = ${Prisma.raw(String(high))} AND objid = ${Prisma.raw(String(low))} AND objsubid = 1 AND pid = pg_backend_pid() AND granted
    ) AS held, current_setting('transaction_isolation') AS isolation`)
  const row = rows[0]
  if (!row?.held) {
    throw new AdminAuditError('AUDIT_NOT_IN_TRANSACTION', 'The audit event must be written inside a transaction: the chain lock is not held across the statements of an ordinary client.')
  }
  if (row.isolation !== 'read committed') {
    throw new AdminAuditError('AUDIT_ISOLATION_UNSUPPORTED', `The audit event must be written by a transaction that reads committed data (this one is "${row.isolation}"): it would not see the event the previous writer stored.`)
  }
}

async function appendInTransaction(tx: Prisma.TransactionClient, input: AdminAuditInput): Promise<AdminAuditRecord> {
  const admin = await tx.user.findUnique({
    where: { id: input.adminId },
    select: { id: true, email: true, name: true },
  })
  if (!admin) {
    throw new AdminAuditError('AUDIT_ACTOR_NOT_FOUND', 'Admin actor not found for audit log')
  }

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_AUDIT_CHAIN_LOCK})`
  await assertChainLockHeld(tx)

  const recent = await tx.adminAuditEvent.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: AUDIT_TAIL_WINDOW,
    select: { id: true, eventHash: true, prevHash: true, createdAt: true },
  })
  // the newest events only say where to START: the event that was really written last may be older than all of them (lib/admin-audit-chain.ts, rule 3) - so each unnamed event of the window is
  // asked who names it (a lookup by predecessor) and the answer is followed to the end of the line
  const successorsOf = (eventHash: string) => tx.adminAuditEvent.findMany({ where: { prevHash: eventHash }, select: { id: true, eventHash: true, prevHash: true, createdAt: true } })
  const { tail, latest, tips } = await chooseAuditTail(recent, successorsOf).catch((error: unknown) => {
    if (error instanceof AuditTailUnresolvedError) throw new AdminAuditError('AUDIT_TAIL_UNRESOLVED', error.message)
    throw error
  })
  if (tips.length > 1) {
    // a fork that is already in the history: not mended and not hidden - counted here, and listed by verifyAdminAuditChain
    incrementMetric('admin_audit_chain_fork_detected_total')
    logEvent({ event: 'admin.audit', level: 'warn', outcome: 'chain_fork_detected', tips: tips.map((event) => event.id), message: 'more than one recent audit event is not named as a predecessor by any other' })
  }
  const stamp = nextAuditTimestamp(new Date(), latest)
  if (stamp.behindMs > AUDIT_CLOCK_BEHIND_ALARM_MS) {
    incrementMetric('admin_audit_clock_behind_total')
    logEvent({ event: 'admin.audit', level: 'warn', outcome: 'clock_behind_the_log', behindMs: stamp.behindMs, message: 'the newest audit event is dated ahead of the clock; the new event follows it' })
  }

  const prevHash = tail?.eventHash || null
  const metadata = storedAuditMetadata(input.metadata)
  const eventHash = auditEventHash({
    prevHash,
    createdAt: stamp.createdAt.toISOString(),
    adminId: admin.id,
    adminEmail: admin.email || null,
    adminName: admin.name || null,
    action: input.action,
    targetType: input.targetType || null,
    targetId: input.targetId || null,
    requestMethod: input.requestMethod,
    requestPath: input.requestPath,
    requestIp: input.requestIp || null,
    userAgent: input.userAgent || null,
    metadata: metadata || null,
  })
  const metadataValue =
    metadata === undefined
      ? undefined
      : metadata === null
        ? Prisma.DbNull
        : (metadata as Prisma.InputJsonValue)

  return tx.adminAuditEvent.create({
    data: {
      adminId: admin.id,
      adminEmail: admin.email || null,
      adminName: admin.name || null,
      action: input.action,
      targetType: input.targetType || null,
      targetId: input.targetId || null,
      requestMethod: input.requestMethod,
      requestPath: input.requestPath,
      requestIp: input.requestIp || null,
      userAgent: input.userAgent || null,
      metadata: metadataValue,
      prevHash,
      eventHash,
      createdAt: stamp.createdAt,
    },
    select: { id: true, eventHash: true, prevHash: true, createdAt: true },
  })
}

/** Joins the caller's transaction (never opens another). The event is committed with the operation, or not at all. */
export function recordAdminAuditEventInTransaction(tx: AuditTransactionClient, input: AdminAuditInput): Promise<AdminAuditRecord> {
  return appendInTransaction(tx, input)
}

/** Opens a short transaction of its own. The chain is whole; the operation the caller did before is NOT part of this transaction. */
export function recordAdminAuditEventStandalone(input: AdminAuditInput): Promise<AdminAuditRecord> {
  return prisma.$transaction((tx) => appendInTransaction(tx, input), STANDALONE_TRANSACTION)
}

/** The call the routes make: with the caller's transaction it joins it, without one it is standalone. */
export async function recordAdminAuditEvent(input: AdminAuditInput, tx?: AuditTransactionClient): Promise<void> {
  if (tx) await recordAdminAuditEventInTransaction(tx, input)
  else await recordAdminAuditEventStandalone(input)
}

// ---- the diagnostic -----------------------------------------------------------------------------------------------------------------------------------------------------------------
/**
 * Reads the whole log in one consistent snapshot and says what shape it has (lib/admin-audit-chain.ts, analyzeAuditChain): forks, dead ends, missing predecessors, hashes that no longer match.
 * It only reads. It never repairs, never deletes and never hides: a fork stays in the log and stays in this report.
 */
export async function verifyAdminAuditChain(options: { batchSize?: number } = {}): Promise<AuditChainReport> {
  const batch = Math.max(100, Math.min(5000, options.batchSize ?? 1000))
  return prisma.$transaction(async (tx) => {
    const events: AuditChainEvent[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await tx.adminAuditEvent.findMany({ orderBy: { id: 'asc' }, take: batch, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })
      for (const row of page) events.push({ ...row, metadata: row.metadata })
      if (page.length < batch) break
      cursor = page[page.length - 1].id
    }
    return analyzeAuditChain(events)
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 120_000 })
}
