// The administrators' audit log is a HASH CHAIN: every event names, as its predecessor, the event written just before it (`prevHash`), and its own hash covers that name, so that an event
// cannot be changed, removed or slipped in without the next one no longer matching. This file is the PURE part of it - no database, no clock but the ones it is given - so that every rule can be
// tested over every combination of events: the hash, which event is the tail to continue from, what instant a new event is stamped with, and what a whole log looks like from outside
// (`analyzeAuditChain`, the diagnostic behind `verifyAdminAuditChain` in lib/admin-audit.ts). Nothing here ever writes, mends or hides anything.
//
// THE RULES THE HELPER (lib/admin-audit.ts) FOLLOWS, and why they are these:
//  1. ONE writer at a time, from before the tail is read until the event is stored: the helper holds `pg_advisory_xact_lock` for the whole sequence, inside ONE transaction (the caller's, or
//     its own). A lock that is not held across the statements protects nothing - which is what an ordinary client without a transaction gave.
//  2. The instant of a new event is taken AFTER the lock, and it is never earlier than the newest event of the log plus one millisecond (`nextAuditTimestamp`). So along the chain the instants
//     strictly increase: no two events share an instant, none is older than the one before it, and "the latest by createdAt" IS the last event of the chain (the ordering of the admin view
//     - createdAt then id - is the order of the chain). The log's column has the millisecond (`TIMESTAMP(3)`), which is why one millisecond is the step.
//     DRIFT: let stamp(n) = max(clock(n), stamp(n-1) + 1 ms). Then stamp(n) - clock(n) <= max(0, stamp(n-1) - clock(n-1) + 1 ms - (clock(n) - clock(n-1))) <= drift(n-1) + 1 ms, because the
//     clock only moves forward between two events written one after the other (the second waited for the first): the lead over the clock grows by at most one millisecond per event of a
//     burst and shrinks by the time that passes. Events that follow each other by humans' hands (admin actions) never lead the clock at all. A clock that steps back, or another instance whose
//     clock is behind, is absorbed the same way - and, when the newest event is more than AUDIT_CLOCK_BEHIND_ALARM_MS ahead of the clock, the helper COUNTS it (it is not silent).
//  3. The tail to continue from is not chosen by the clock alone. Among the newest AUDIT_TAIL_WINDOW events it is the one that no other event of the window names as its predecessor
//     (`chooseAuditTail`): in a healthy log that is the newest event, and in a log that already holds events stamped out of order (what the published helper could leave) it is still the event
//     that was REALLY written last. Events written by the fixed helper cannot be out of order; this protects the history that was written before it.
//     If more than one event of the window is unnamed (a fork already in the history) the newest of them is continued - nothing is rewritten, the helper counts that it saw the fork
//     (admin_audit_chain_fork_detected_total), and `analyzeAuditChain` keeps reporting it.
//  4. The hash format is unchanged (same material, same canonical form, SHA-256). The metadata that goes into the hash is the metadata AS THE DATABASE WILL HOLD IT (JSON: no `undefined`
//     properties, dates as text), so that an event can be re-checked from what is stored.
import { createHash } from 'node:crypto'

export const AUDIT_TAIL_WINDOW = 64
export const AUDIT_CLOCK_BEHIND_ALARM_MS = 60_000

// ---- the hash -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export type AuditHashMaterial = {
  prevHash: string | null
  createdAt: string                  // the ISO form of the stored instant
  adminId: string
  adminEmail: string | null
  adminName: string | null
  action: string
  targetType: string | null
  targetId: string | null
  requestMethod: string
  requestPath: string
  requestIp: string | null
  userAgent: string | null
  metadata: unknown
}
export function auditEventHash(material: AuditHashMaterial): string {
  return createHash('sha256').update(stableJson(material)).digest('hex')
}

// What the database will hold for a metadata value: JSON, as `JSON.stringify` writes it (an `undefined` property is gone, a Date is its ISO text). `undefined` stays `undefined` (no metadata).
export function storedAuditMetadata(metadata: unknown): unknown {
  if (metadata === undefined) return undefined
  const text = JSON.stringify(metadata)
  return text === undefined ? undefined : JSON.parse(text)
}

// ---- which event to continue from -----------------------------------------------------------------------------------------------------------------------------------------------
export type AuditTailFact = { id: string; eventHash: string; prevHash: string | null; createdAt: Date }
const newestFirst = (a: AuditTailFact, b: AuditTailFact) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

export function chooseAuditTail<T extends AuditTailFact>(recent: ReadonlyArray<T>): { tail: T | null; latest: T | null; tips: T[] } {
  if (recent.length === 0) return { tail: null, latest: null, tips: [] }
  const ordered = [...recent].sort(newestFirst)
  const named = new Set<string>()
  for (const event of ordered) if (event.prevHash) named.add(event.prevHash)
  const tips = ordered.filter((event) => !named.has(event.eventHash))
  return { tail: tips[0] ?? ordered[0], latest: ordered[0], tips }
}

// ---- which instant to stamp it with ---------------------------------------------------------------------------------------------------------------------------------------------
export function nextAuditTimestamp(now: Date, latest: { createdAt: Date } | null): { createdAt: Date; floored: boolean; behindMs: number } {
  const clock = now.getTime()
  if (!latest) return { createdAt: new Date(clock), floored: false, behindMs: 0 }
  const floor = latest.createdAt.getTime() + 1
  if (clock >= floor) return { createdAt: new Date(clock), floored: false, behindMs: 0 }
  return { createdAt: new Date(floor), floored: true, behindMs: latest.createdAt.getTime() - clock }
}

// ---- what a whole log looks like from outside -----------------------------------------------------------------------------------------------------------------------------------
export type AuditChainEvent = {
  id: string
  adminId: string | null
  adminEmail: string | null
  adminName: string | null
  action: string
  targetType: string | null
  targetId: string | null
  requestMethod: string
  requestPath: string
  requestIp: string | null
  userAgent: string | null
  metadata: unknown
  prevHash: string | null
  eventHash: string
  createdAt: Date
}
export type AuditChainReport = {
  /** true only for a log that is ONE line from its first event to its last, whose every hash is the hash of its own fields */
  ok: boolean
  events: number
  /** events with no predecessor (a whole chain has one) */
  heads: string[]
  /** events that no other event names as its predecessor (a whole chain has one) */
  tips: string[]
  /** predecessors that more than one event names: a fork */
  forks: Array<{ prevHash: string; eventIds: string[] }>
  /** events that are not on the line from the newest tip back to the first event (the dead ends of the forks) */
  offChain: string[]
  /** events whose predecessor is not in the log (an event was removed, or the log was cut) */
  danglingPredecessors: string[]
  /** hashes stored by more than one event (the unique index forbids it: reported if it ever happens) */
  duplicateHashes: string[]
  /** events whose stored hash is not the hash of their own stored fields */
  hashMismatches: string[]
  /** events that could not be re-checked because their administrator no longer exists (the id is part of the hash and was set to null with the account) */
  unverifiable: number
  /** events whose instant is not after their predecessor's (what the published helper could leave; informational: it does not make the chain not whole) */
  timeDisorder: string[]
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function analyzeAuditChain(events: ReadonlyArray<AuditChainEvent>): AuditChainReport {
  const byHash = new Map<string, AuditChainEvent>()
  const duplicates = new Set<string>()
  for (const event of events) {
    if (byHash.has(event.eventHash)) duplicates.add(event.eventHash)
    else byHash.set(event.eventHash, event)
  }
  const successors = new Map<string, string[]>()
  for (const event of events) {
    if (!event.prevHash) continue
    const list = successors.get(event.prevHash)
    if (list) list.push(event.id)
    else successors.set(event.prevHash, [event.id])
  }
  const heads = events.filter((event) => !event.prevHash).map((event) => event.id).sort(byId)
  const tipEvents = events.filter((event) => !successors.has(event.eventHash))
  const tips = tipEvents.map((event) => event.id).sort(byId)
  const forks = [...successors.entries()].filter(([, ids]) => ids.length > 1).map(([prevHash, ids]) => ({ prevHash, eventIds: [...ids].sort(byId) })).sort((a, b) => byId(a.prevHash, b.prevHash))
  const dangling = events.filter((event) => event.prevHash && !byHash.has(event.prevHash)).map((event) => event.id).sort(byId)

  // the line: from the newest tip back to the first event
  const line = new Set<string>()
  const newestTip = [...tipEvents].sort(newestFirst)[0]
  for (let current: AuditChainEvent | undefined = newestTip; current && !line.has(current.id); current = current.prevHash ? byHash.get(current.prevHash) : undefined) line.add(current.id)
  const offChain = events.filter((event) => !line.has(event.id)).map((event) => event.id).sort(byId)

  const hashMismatches: string[] = []
  let unverifiable = 0
  for (const event of events) {
    if (!event.adminId) { unverifiable++; continue }
    const expected = auditEventHash({
      prevHash: event.prevHash ?? null, createdAt: event.createdAt.toISOString(), adminId: event.adminId, adminEmail: event.adminEmail || null, adminName: event.adminName || null,
      action: event.action, targetType: event.targetType || null, targetId: event.targetId || null, requestMethod: event.requestMethod, requestPath: event.requestPath,
      requestIp: event.requestIp || null, userAgent: event.userAgent || null, metadata: event.metadata || null,
    })
    if (expected !== event.eventHash) hashMismatches.push(event.id)
  }
  const timeDisorder = events.filter((event) => {
    const before = event.prevHash ? byHash.get(event.prevHash) : undefined
    return before ? !(event.createdAt.getTime() > before.createdAt.getTime()) : false
  }).map((event) => event.id).sort(byId)

  const whole = events.length === 0
    || (heads.length === 1 && tips.length === 1 && forks.length === 0 && offChain.length === 0 && dangling.length === 0 && duplicates.size === 0 && hashMismatches.length === 0)
  return {
    ok: whole, events: events.length, heads, tips, forks, offChain, danglingPredecessors: dangling, duplicateHashes: [...duplicates].sort(), hashMismatches: hashMismatches.sort(byId), unverifiable, timeDisorder,
  }
}
