// The pure part of the administrators' audit chain (lib/admin-audit-chain.ts): the hash (whose FORMAT is pinned), which event is the tail to continue, what instant a new event is stamped with, and
// what a whole log looks like from outside. No database: tests/security/admin-audit-chain.sec.ts is the proof on the real thing; this file is the proof over every combination.
// Plus the guards on the source that keep every caller of the helper honest.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import {
  AUDIT_TAIL_WINDOW, analyzeAuditChain, auditEventHash, chooseAuditTail, nextAuditTimestamp, stableJson, storedAuditMetadata,
  type AuditChainEvent, type AuditHashMaterial, type AuditTailFact,
} from '../lib/admin-audit-chain'

// ---- the hash: the format of the helper as it was published, copied here byte for byte ---------------------------------------------------------------------------------------------
function publishedStableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => publishedStableJson(entry)).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${publishedStableJson(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const publishedHash = (material: unknown) => createHash('sha256').update(publishedStableJson(material)).digest('hex')

const M1: AuditHashMaterial = {
  prevHash: null, createdAt: '2026-11-05T12:00:00.000Z', adminId: 'cadmin000000000000000001', adminEmail: 'admin@example.test', adminName: 'Ada Admin', action: 'admin.order.status.update',
  targetType: 'print_order', targetId: 'corder0000000000000000001', requestMethod: 'PATCH', requestPath: '/api/admin/orders/corder0000000000000000001/status', requestIp: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (test)', metadata: { status: 'queued', previousStatus: 'awaiting_review', failureNote: null, nested: { b: [1, 2, { z: true, a: 'é' }], a: 0.5 }, list: ['x', 'y'] },
}
const M2: AuditHashMaterial = { ...M1, prevHash: '89dec21406ebd7dd527fcc9cf575565b0be6191a92c0a63aa7c705c4d2e31e7d', createdAt: '2026-11-05T12:00:00.001Z', action: 'admin.order.delete', metadata: null, requestIp: null, userAgent: null, adminName: null }

test('the hash format is PINNED: two golden values computed with the helper as it was published, and the same canonical form on a corpus', () => {
  assert.equal(auditEventHash(M1), '89dec21406ebd7dd527fcc9cf575565b0be6191a92c0a63aa7c705c4d2e31e7d')
  assert.equal(auditEventHash(M2), '17c64dddab033d6aa47e0b10e1442c32171b8aa24115230f77c2f61641f39acb')
  const corpus: unknown[] = [
    null, 0, 1.5, -2, true, false, '', 'plain', 'unicode é ü 日本', 'quote " and \\ and \n', [], {}, [1, [2, [3]]], { b: 1, a: 2 }, { a: { c: [{ z: 1, y: null }], b: 'x' } },
    { undef: undefined, kept: 1 }, [undefined, null], { 'ключ': 'значение', '': 'empty key' },
  ]
  for (const value of corpus) {
    assert.equal(stableJson(value), publishedStableJson(value), JSON.stringify(value))
    assert.equal(auditEventHash({ ...M1, metadata: value }), publishedHash({ ...M1, metadata: value }), JSON.stringify(value))
  }
})

test('the metadata that is hashed is what the database holds: no undefined property, dates as text, nothing that JSON cannot carry', () => {
  assert.equal(storedAuditMetadata(undefined), undefined)
  assert.equal(storedAuditMetadata(null), null)
  assert.deepEqual(storedAuditMetadata({ a: 1, skipped: undefined, nested: { gone: undefined, kept: [1, undefined, 3] } }), { a: 1, nested: { kept: [1, null, 3] } })
  assert.deepEqual(storedAuditMetadata({ when: new Date(Date.UTC(2026, 10, 5, 12, 0, 0)) }), { when: '2026-11-05T12:00:00.000Z' })
  assert.equal(storedAuditMetadata(0), 0)
  assert.equal(storedAuditMetadata('text'), 'text')
  assert.equal(storedAuditMetadata(() => 1), undefined)
  // and so the hash of an event can be recomputed from what is stored
  const input = { a: 1, skipped: undefined, when: new Date(1700000000000) }
  const stored = JSON.parse(JSON.stringify(input))
  assert.equal(auditEventHash({ ...M1, metadata: storedAuditMetadata(input) }), auditEventHash({ ...M1, metadata: stored }))
})

// ---- which event to continue ---------------------------------------------------------------------------------------------------------------------------------------------------------------
let seq = 0
const fact = (id: string, prev: AuditTailFact | null, at: number): AuditTailFact => ({ id, eventHash: `hash-${id}-${++seq}`, prevHash: prev?.eventHash ?? null, createdAt: new Date(at) })
const shuffle = <T,>(list: T[], seed: number) => { const out = [...list]; let s = seed; for (let i = out.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [out[i], out[j]] = [out[j], out[i]] } return out }

test('tail: nothing yet; one event; a linear window continues from the newest; the order the events are handed over in does not matter', () => {
  assert.deepEqual(chooseAuditTail([]), { tail: null, latest: null, tips: [] })
  const a = fact('a', null, 1000)
  assert.equal(chooseAuditTail([a]).tail, a)
  const b = fact('b', a, 1010), c = fact('c', b, 1020), d = fact('d', c, 1030)
  for (let seed = 1; seed <= 20; seed++) {
    const r = chooseAuditTail(shuffle([a, b, c, d], seed))
    assert.equal(r.tail, d)
    assert.equal(r.latest, d)
    assert.deepEqual(r.tips, [d])
  }
})

test('tail: the event that was REALLY written last is continued even when its instant is older than the one before it (what the published helper could leave)', () => {
  const b = fact('b', null, 1000)
  const a = fact('a', b, 995)                     // written after B, stamped before it
  const r = chooseAuditTail([b, a])
  assert.equal(r.latest, b, 'the latest instant is B')
  assert.equal(r.tail, a, 'the last event of the chain is A')
  assert.deepEqual(r.tips, [a])
  // longer: ... <- b <- a <- x with x also inverted
  const x = fact('x', a, 990)
  assert.equal(chooseAuditTail([b, a, x]).tail, x)
})

test('tail: a fork in the window - more than one event nobody names - continues the newest of them and says there are several (nothing is chosen silently)', () => {
  const head = fact('head', null, 1000), p = fact('p', head, 1010)
  const a = fact('a', p, 1020), c = fact('c', p, 1021), d = fact('d', c, 1030)
  const r = chooseAuditTail([head, p, a, c, d])
  assert.deepEqual(r.tips.map((t) => t.id), ['d', 'a'], 'newest first')
  assert.equal(r.tail, d)
  // the dead end is the newest event: it is the one continued (the rule is deterministic, and the fork is reported by the helper and by the diagnostic)
  const late = fact('late', p, 1040)
  assert.equal(chooseAuditTail([head, p, a, c, d, late]).tail, late)
})

test('tail: equal instants are ordered by id, newest id first, the same way the database orders them for the window', () => {
  const x = fact('x', null, 1000), y = fact('y', x, 1000)     // an old tie: y continues x
  const r = chooseAuditTail([x, y])
  assert.equal(r.tail, y, 'y is the one nobody names, whatever the ids say')
  assert.equal(r.latest?.id, 'y')
})

test('tail: a window cut in the middle of a chain still finds the end (the first event of the window names an event that is not in it)', () => {
  const chain: AuditTailFact[] = []
  for (let i = 0; i < AUDIT_TAIL_WINDOW + 20; i++) chain.push(fact(`e${i}`, chain[i - 1] ?? null, 1000 + i * 10))
  const window = chain.slice(-AUDIT_TAIL_WINDOW)
  const r = chooseAuditTail(window)
  assert.equal(r.tail, chain[chain.length - 1])
  assert.equal(r.tips.length, 1)
})

test('tail: over many random chains with instants that jitter out of order within a few events, the tail is always the last event written', () => {
  let s = 12345
  const rnd = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n }
  for (let round = 0; round < 300; round++) {
    const n = 2 + rnd(AUDIT_TAIL_WINDOW - 1)
    const chain: AuditTailFact[] = []
    let clock = 1_000_000
    for (let i = 0; i < n; i++) { clock += 1 + rnd(5); chain.push(fact(`r${round}-${i}`, chain[i - 1] ?? null, clock - rnd(4))) }   // instants out of order by up to 3 ms
    const r = chooseAuditTail(shuffle(chain, round + 1))
    assert.equal(r.tail, chain[chain.length - 1], `round ${round}`)
    assert.equal(r.tips.length, 1)
  }
})

// ---- which instant ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('instant: the clock when it is ahead of the newest event; one millisecond after the newest event when it is not; the alarm size when the clock is far behind', () => {
  const at = (ms: number) => new Date(ms)
  assert.deepEqual(nextAuditTimestamp(at(5000), null), { createdAt: at(5000), floored: false, behindMs: 0 })
  assert.deepEqual(nextAuditTimestamp(at(5000), { createdAt: at(4000) }), { createdAt: at(5000), floored: false, behindMs: 0 })
  assert.deepEqual(nextAuditTimestamp(at(5000), { createdAt: at(4999) }), { createdAt: at(5000), floored: false, behindMs: 0 }, 'one millisecond after is the clock itself')
  assert.deepEqual(nextAuditTimestamp(at(5000), { createdAt: at(5000) }), { createdAt: at(5001), floored: true, behindMs: 0 }, 'the same millisecond is not allowed twice')
  assert.deepEqual(nextAuditTimestamp(at(5000), { createdAt: at(5100) }), { createdAt: at(5101), floored: true, behindMs: 100 })
  assert.deepEqual(nextAuditTimestamp(at(5000), { createdAt: at(605_000) }), { createdAt: at(605_001), floored: true, behindMs: 600_000 })
})

test('instant: along any sequence of clocks - forwards, repeated, stepping back - the stamps STRICTLY increase, and never fall behind the clock', () => {
  let s = 987
  const rnd = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n }
  for (let round = 0; round < 200; round++) {
    let latest: { createdAt: Date } | null = null
    let clock = 10_000
    for (let i = 0; i < 60; i++) {
      clock += rnd(7) - (rnd(10) === 0 ? 500 : 0)                         // mostly forwards, sometimes the same millisecond, sometimes a big step back
      const stamp = nextAuditTimestamp(new Date(clock), latest)
      if (latest) assert.ok(stamp.createdAt.getTime() > latest.createdAt.getTime(), `round ${round} step ${i}`)
      assert.ok(stamp.createdAt.getTime() >= clock)
      latest = stamp
    }
  }
})

test('instant: DRIFT - with a clock that only moves forward, the lead over the clock is at most one millisecond per event of the burst, and gone as soon as time passes', () => {
  // thirty events in the SAME millisecond: the lead grows by one each, never more
  let latest: { createdAt: Date } | null = null
  for (let i = 1; i <= 30; i++) { const stamp = nextAuditTimestamp(new Date(50_000), latest); assert.equal(stamp.createdAt.getTime() - 50_000, i - 1); latest = stamp }
  // the clock moves on by the size of the lead: no lead any more
  const caught = nextAuditTimestamp(new Date(50_030), latest)
  assert.equal(caught.createdAt.getTime(), 50_030)
  assert.equal(caught.floored, false)
  // and over random non-decreasing clocks the lead is bounded by the number of events so far
  let s = 4242
  const rnd = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n }
  for (let round = 0; round < 100; round++) {
    let last: { createdAt: Date } | null = null
    let clock = 1_000
    for (let i = 1; i <= 100; i++) {
      clock += rnd(3)
      const stamp = nextAuditTimestamp(new Date(clock), last)
      assert.ok(stamp.createdAt.getTime() - clock <= i, `round ${round} event ${i}: lead ${stamp.createdAt.getTime() - clock}`)
      last = stamp
    }
  }
})

// ---- what a whole log looks like -----------------------------------------------------------------------------------------------------------------------------------------------------------
let cseq = 0
function chainOf(count: number, over: (i: number) => Partial<AuditChainEvent> = () => ({})): AuditChainEvent[] {
  const events: AuditChainEvent[] = []
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.UTC(2026, 10, 5, 12, 0, 0) + i * 10)
    const base = {
      id: `e${String(++cseq).padStart(5, '0')}`, adminId: 'cadmin000000000000000001', adminEmail: 'admin@example.test', adminName: 'Ada', action: `act.${i}`, targetType: 'probe', targetId: `t${i}`,
      requestMethod: 'TEST', requestPath: '/x', requestIp: null, userAgent: null, metadata: { i } as unknown, createdAt: at, prevHash: events[i - 1]?.eventHash ?? null,
    }
    const merged = { ...base, ...over(i) }
    const eventHash = auditEventHash({
      prevHash: merged.prevHash, createdAt: merged.createdAt.toISOString(), adminId: merged.adminId as string, adminEmail: merged.adminEmail, adminName: merged.adminName, action: merged.action,
      targetType: merged.targetType, targetId: merged.targetId, requestMethod: merged.requestMethod, requestPath: merged.requestPath, requestIp: merged.requestIp, userAgent: merged.userAgent,
      metadata: merged.metadata || null,
    })
    events.push({ ...merged, eventHash })
  }
  return events
}

test('log: empty and whole logs are ok; a whole log has one head, one tip, nothing off the line', () => {
  assert.equal(analyzeAuditChain([]).ok, true)
  const r = analyzeAuditChain(chainOf(8))
  assert.equal(r.ok, true)
  assert.equal(r.events, 8)
  assert.equal(r.heads.length, 1)
  assert.equal(r.tips.length, 1)
  assert.deepEqual([r.forks, r.offChain, r.danglingPredecessors, r.duplicateHashes, r.hashMismatches, r.timeDisorder], [[], [], [], [], [], []])
  assert.equal(r.unverifiable, 0)
  assert.equal(analyzeAuditChain(shuffle(chainOf(8), 3)).ok, true, 'the order the rows are handed over in does not matter')
})

test('log: a fork is named - the shared predecessor, who shares it, the tips, the dead end', () => {
  const events = chainOf(5)                                              // 0 <- 1 <- 2 <- 3 <- 4
  const dead = chainOf(1, () => ({ prevHash: events[1].eventHash, createdAt: new Date(Date.UTC(2026, 10, 5, 12, 0, 0) + 25), action: 'dead.end' }))[0]   // a second child of 1
  const r = analyzeAuditChain([...events, dead])
  assert.equal(r.ok, false)
  assert.deepEqual(r.forks, [{ prevHash: events[1].eventHash, eventIds: [events[2].id, dead.id].sort() }])
  assert.deepEqual([...r.tips].sort(), [dead.id, events[4].id].sort())
  assert.deepEqual(r.offChain, [dead.id])
  assert.deepEqual(r.heads, [events[0].id])
  assert.deepEqual(r.hashMismatches, [])
})

test('log: a missing predecessor, a second head, a duplicated hash, a changed field, an account that is gone', () => {
  const events = chainOf(4)
  const cut = analyzeAuditChain(events.slice(1))
  assert.equal(cut.ok, false)
  assert.deepEqual(cut.danglingPredecessors, [events[1].id], 'the log was cut: the oldest remaining event names one that is not there')
  const twoHeads = analyzeAuditChain([...events, ...chainOf(2, (i) => ({ action: `second.${i}` }))])     // a second line, with material of its own
  assert.equal(twoHeads.ok, false)
  assert.equal(twoHeads.heads.length, 2)
  assert.equal(twoHeads.tips.length, 2)
  const twin = { ...events[3], id: 'twin' }
  assert.deepEqual(analyzeAuditChain([...events, twin]).duplicateHashes, [events[3].eventHash])
  const tampered = events.map((e, i) => (i === 2 ? { ...e, action: 'changed' } : e))
  const t = analyzeAuditChain(tampered)
  assert.equal(t.ok, false)
  assert.deepEqual(t.hashMismatches, [events[2].id])
  const gone = events.map((e, i) => (i === 1 ? { ...e, adminId: null } : e))
  const g = analyzeAuditChain(gone)
  assert.equal(g.ok, true, 'an event whose administrator is gone is not called wrong')
  assert.equal(g.unverifiable, 1)
})

test('log: instants out of order are reported apart (informational) and do not make a whole chain not whole; a cycle cannot make the analysis loop', () => {
  const T = Date.UTC(2026, 10, 5, 12, 0, 0)
  const b = chainOf(1, () => ({ createdAt: new Date(T + 100) }))[0]
  const a = chainOf(1, () => ({ prevHash: b.eventHash, createdAt: new Date(T + 95) }))[0]
  const r = analyzeAuditChain([b, a])
  assert.equal(r.ok, true)
  assert.deepEqual(r.timeDisorder, [a.id])
  // two events that name each other: nothing is a tip, the line is empty, everything is off it - and it ends
  const x = { ...chainOf(1)[0], id: 'x', eventHash: 'hx', prevHash: 'hy' }
  const y = { ...chainOf(1)[0], id: 'y', eventHash: 'hy', prevHash: 'hx' }
  const cyc = analyzeAuditChain([x, y])
  assert.equal(cyc.ok, false)
  assert.deepEqual(cyc.tips, [])
  assert.deepEqual(cyc.offChain, ['x', 'y'])
})

test('log: a long whole log is analysed in one pass', () => {
  const started = Date.now()
  const r = analyzeAuditChain(chainOf(20_000))
  assert.equal(r.ok, true)
  assert.ok(Date.now() - started < 10_000, 'twenty thousand events well under ten seconds')
})

// ---- guards on the source -------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ROOT = process.cwd()
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) { if (!['node_modules', '.next'].includes(entry.name)) sources(relative, out) }
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(relative)
  }
  return out
}
function auditCalls() {
  const found: Array<{ file: string; line: number; callee: string; args: string[] }> = []
  for (const file of ['lib', 'app', 'scripts', 'components'].flatMap((dir) => sources(dir))) {
    const text = readFileSync(path.join(ROOT, file), 'utf8')
    if (!text.includes('recordAdminAuditEvent')) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf)
        if (callee === 'recordAdminAuditEvent' || callee.endsWith('.recordAdminAuditEvent')) {
          found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, callee, args: node.arguments.map((arg) => arg.getText(sf)) })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return found
}

test('G-source: every call of the helper hands over `tx` (the caller\'s transaction) or nothing - never the ordinary client, never anything else that would need a second look', () => {
  const calls = auditCalls()
  assert.ok(calls.length >= 31, `the 31 call sites known when the helper was fixed are all still found (${calls.length})`)
  const odd = calls.filter((c) => !(c.args.length === 1 || (c.args.length === 2 && c.args[1] === 'tx')))
  assert.deepEqual(odd, [], 'a call hands over something that is not `tx`: is it a transaction?')
})

test('G-source: nothing but lib/admin-audit.ts writes the audit log, and the pure part of the chain imports nothing that reads or writes', () => {
  const writers: string[] = []
  for (const file of ['lib', 'app', 'scripts', 'components'].flatMap((dir) => sources(dir))) {
    const text = readFileSync(path.join(ROOT, file), 'utf8')
    if (/adminAuditEvent\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(text) || /"AdminAuditEvent"/.test(text)) writers.push(file)
  }
  assert.deepEqual(writers, ['lib/admin-audit.ts'].filter((file) => writers.includes(file)), 'only the helper writes to the audit log')
  const pure = readFileSync(path.join(ROOT, 'lib/admin-audit-chain.ts'), 'utf8')
  const imports = [...pure.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['node:crypto'], 'the pure part imports only the hash')
  const helper = readFileSync(path.join(ROOT, 'lib/admin-audit.ts'), 'utf8')
  assert.match(helper, /pg_advisory_xact_lock/)
  assert.match(helper, /assertChainLockHeld\(tx\)/, 'the lock is checked, in the database, before anything is read or written')
})
