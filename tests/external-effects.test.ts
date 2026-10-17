// Step 4.6, S4 - the journal of effects on outside services (lib/external-effects.ts). No database, no network.
// The rules under test: an intent is written BEFORE a call; an intent without an outcome is UNCERTAIN; nothing is sent again from `uncertain`; the way out is proof
// that the effect exists (never the absence of a record, never a declaration); and how a call that failed is classified.
import assert from 'node:assert/strict'
import test from 'node:test'
import * as effects from '../lib/external-effects'
import {
  BAD_RESPONSE, INTENT_CLAIM_TTL_MS, beginEffects, classifyExternalFailure, confirmEffectByProof, describeEffect, hasRecordedEffect, hasUnresolvedEffect, readJournal,
  recordEffectOutcome, renewIntents, unresolvedEffects, type BeginRequest,
} from '../lib/external-effects'

const T0 = Date.parse('2026-10-17T10:00:00Z')
const REQ: BeginRequest = { key: 'printlab:item:i1', kind: 'printlab_submit', by: 'admin_1', adminId: 'a1', detail: { idempotencyKey: 'makerworks-order:o1:item:i1', itemId: 'i1' } }
const REQ2: BeginRequest = { key: 'printlab:item:i2', kind: 'printlab_submit', by: 'admin_1', adminId: 'a1', detail: { itemId: 'i2' } }

test('first attempt: an intent is written, with a claim, before any call', () => {
  const { metadata, verdicts } = beginEffects({ note: 'x' }, [REQ], { now: T0 })
  assert.equal(verdicts[REQ.key].verdict, 'proceed')
  const record = readJournal(metadata)[REQ.key]
  assert.equal(record.state, 'intent')
  assert.equal(record.attempts, 1)
  assert.equal(record.claimUntil, new Date(T0 + INTENT_CLAIM_TTL_MS).toISOString())
  assert.ok(record.intentId.length > 10)
  assert.equal((metadata as any).note, 'x', 'the rest of the metadata is untouched')
  assert.deepEqual(record.detail, REQ.detail)
})

test('a second process while the claim is live: in progress, nothing new written', () => {
  const first = beginEffects({}, [REQ], { now: T0 })
  const second = beginEffects(first.metadata, [REQ], { now: T0 + 60_000 })
  assert.equal(second.verdicts[REQ.key].verdict, 'in_progress')
  assert.equal(readJournal(second.metadata)[REQ.key].intentId, readJournal(first.metadata)[REQ.key].intentId)
})

test('an intent whose claim ran out is UNCERTAIN, never a license to send again (process restart)', () => {
  const first = beginEffects({}, [REQ], { now: T0 })
  const later = beginEffects(first.metadata, [REQ], { now: T0 + INTENT_CLAIM_TTL_MS + 1 })
  assert.equal(later.verdicts[REQ.key].verdict, 'unknown_outcome')
  const record = readJournal(later.metadata)[REQ.key]
  assert.equal(record.state, 'uncertain')
  assert.equal(record.cause, 'claim_expired')
  // and it stays so, however long we wait and however often we ask
  for (const delay of [10, 3600, 86_400, 30 * 86_400]) {
    const again = beginEffects(later.metadata, [REQ], { now: T0 + delay * 1000 })
    assert.equal(again.verdicts[REQ.key].verdict, 'unknown_outcome')
    assert.equal(readJournal(again.metadata)[REQ.key].state, 'uncertain')
  }
})

test('confirmed is never sent again; rejected and not_sent are provably nothing and may be tried again', () => {
  const begun = beginEffects({}, [REQ, REQ2], { now: T0 })
  const keyIntent = readJournal(begun.metadata)[REQ.key].intentId
  const done = recordEffectOutcome(begun.metadata, REQ.key, keyIntent, { state: 'confirmed', externalId: 'job_1' }, { now: T0 })
  assert.equal(beginEffects(done.metadata, [REQ], { now: T0 }).verdicts[REQ.key].verdict, 'already_done')
  for (const state of ['rejected', 'not_sent'] as const) {
    const intent2 = readJournal(begun.metadata)[REQ2.key].intentId
    const ended = recordEffectOutcome(begun.metadata, REQ2.key, intent2, { state, cause: 'x', message: 'nothing happened' }, { now: T0 })
    const retry = beginEffects(ended.metadata, [REQ2], { now: T0 + 1000 })
    assert.equal(retry.verdicts[REQ2.key].verdict, 'proceed', state)
    assert.equal(readJournal(retry.metadata)[REQ2.key].attempts, 2, 'the attempt count goes on')
    assert.notEqual(readJournal(retry.metadata)[REQ2.key].intentId, intent2, 'a new intent')
  }
})

test('uncertain stays uncertain: the same answer every time, whatever the clock says', () => {
  const begun = beginEffects({}, [REQ], { now: T0 })
  const intent = readJournal(begun.metadata)[REQ.key].intentId
  const ended = recordEffectOutcome(begun.metadata, REQ.key, intent, { state: 'uncertain', cause: 'timeout', message: 'timed out' }, { now: T0 })
  for (const delay of [0, 600, 100_000]) assert.equal(beginEffects(ended.metadata, [REQ], { now: T0 + delay * 1000 }).verdicts[REQ.key].verdict, 'unknown_outcome')
})

test('an order whose metadata was erased has no history: every effect starts uncertain', () => {
  const { metadata, verdicts } = beginEffects(null, [REQ], { now: T0, metadataLost: true })
  assert.equal(verdicts[REQ.key].verdict, 'unknown_outcome')
  const record = readJournal(metadata)[REQ.key]
  assert.equal(record.state, 'uncertain')
  assert.equal(record.cause, 'metadata_lost')
  // an order with metadata and no record is simply new
  assert.equal(beginEffects({}, [REQ], { now: T0, metadataLost: false }).verdicts[REQ.key].verdict, 'proceed')
  // but a record that exists is respected even when the flag is set
  const begun = beginEffects({}, [REQ], { now: T0 })
  assert.equal(beginEffects(begun.metadata, [REQ], { now: T0, metadataLost: true }).verdicts[REQ.key].verdict, 'in_progress')
})

test('each effect is decided on its own: one in doubt does not hold back an independent one', () => {
  const first = beginEffects({}, [REQ], { now: T0 })
  const intent = readJournal(first.metadata)[REQ.key].intentId
  const doubt = recordEffectOutcome(first.metadata, REQ.key, intent, { state: 'uncertain', cause: 'timeout', message: 'x' }, { now: T0 })
  const both = beginEffects(doubt.metadata, [REQ, REQ2], { now: T0 })
  assert.equal(both.verdicts[REQ.key].verdict, 'unknown_outcome')
  assert.equal(both.verdicts[REQ2.key].verdict, 'proceed')
})

test('renewing a claim: only the intent that is ours and still live', () => {
  const begun = beginEffects({}, [REQ, REQ2], { now: T0 })
  const j = readJournal(begun.metadata)
  const renewed = renewIntents(begun.metadata, [{ key: REQ.key, intentId: j[REQ.key].intentId }, { key: REQ2.key, intentId: 'someone-else' }, { key: 'missing', intentId: 'x' }], T0 + 200_000)
  assert.deepEqual(renewed.renewed, [REQ.key])
  assert.deepEqual(renewed.lost.sort(), ['missing', REQ2.key].sort())
  assert.equal(readJournal(renewed.metadata)[REQ.key].claimUntil, new Date(T0 + 200_000 + INTENT_CLAIM_TTL_MS).toISOString())
  assert.equal(readJournal(renewed.metadata)[REQ2.key].claimUntil, j[REQ2.key].claimUntil, 'not ours: untouched')
})

test('an outcome applies to its own attempt only, and never downgrades a confirmed effect', () => {
  const begun = beginEffects({}, [REQ], { now: T0 })
  const intent = readJournal(begun.metadata)[REQ.key].intentId
  const wrong = recordEffectOutcome(begun.metadata, REQ.key, 'another-attempt', { state: 'confirmed', externalId: 'z' }, { now: T0 })
  assert.equal(wrong.applied, false)
  assert.equal(readJournal(wrong.metadata)[REQ.key].state, 'intent')
  const confirmed = recordEffectOutcome(begun.metadata, REQ.key, intent, { state: 'confirmed', externalId: 'job_9', httpStatus: 200 }, { now: T0 + 5 })
  assert.equal(confirmed.applied, true)
  const rec = readJournal(confirmed.metadata)[REQ.key]
  assert.deepEqual([rec.state, rec.externalId, rec.confirmedBy, rec.claimUntil, rec.httpStatus], ['confirmed', 'job_9', 'response', null, 200])
  const downgrade = recordEffectOutcome(confirmed.metadata, REQ.key, intent, { state: 'uncertain', cause: 'timeout', message: 'late' }, { now: T0 + 10 })
  assert.equal(downgrade.applied, false)
  assert.equal(readJournal(downgrade.metadata)[REQ.key].state, 'confirmed')
})

test('a definite answer from the original process overrides a lapsed claim; a block that arrived during the call stays visible', () => {
  const begun = beginEffects({}, [REQ], { now: T0 })
  const intent = readJournal(begun.metadata)[REQ.key].intentId
  const lapsed = beginEffects(begun.metadata, [REQ], { now: T0 + INTENT_CLAIM_TTL_MS + 1 })
  assert.equal(readJournal(lapsed.metadata)[REQ.key].state, 'uncertain')
  const late = recordEffectOutcome(lapsed.metadata, REQ.key, intent, { state: 'confirmed', externalId: 'job_late' }, { now: T0 + INTENT_CLAIM_TTL_MS + 5, blockedAfterSend: true })
  assert.equal(late.applied, true)
  const rec = readJournal(late.metadata)[REQ.key]
  assert.equal(rec.state, 'confirmed')
  assert.equal(rec.blockedAfterSend, true)
})

test('the way out of "uncertain" is proof that the effect exists - and it can not be reached by waiting or by saying so', () => {
  const begun = beginEffects({}, [REQ], { now: T0 })
  const intent = readJournal(begun.metadata)[REQ.key].intentId
  const doubt = recordEffectOutcome(begun.metadata, REQ.key, intent, { state: 'uncertain', cause: 'timeout', message: 'x' }, { now: T0 })
  assert.equal(hasUnresolvedEffect(doubt.metadata), true)
  const proven = confirmEffectByProof(doubt.metadata, REQ.key, { externalId: 'job_found', confirmedBy: 'reconciliation' }, T0 + 5)
  assert.equal(proven.applied, true)
  assert.equal(proven.before, 'uncertain')
  const rec = readJournal(proven.metadata)[REQ.key]
  assert.deepEqual([rec.state, rec.confirmedBy, rec.externalId], ['confirmed', 'reconciliation', 'job_found'])
  assert.equal(hasUnresolvedEffect(proven.metadata), false)
  assert.equal(confirmEffectByProof(proven.metadata, REQ.key, { externalId: 'other', confirmedBy: 'admin_proof' }).applied, false, 'already confirmed')
  assert.equal(confirmEffectByProof(doubt.metadata, 'nothing-here', { externalId: 'x', confirmedBy: 'admin_proof' }).applied, false)
  // there is no function that turns an uncertain record back into one that can be sent: the only exits are the two above
  const exits = Object.keys(effects).filter((name) => /allow|retry|reset|clear|forget|release/i.test(name))
  assert.deepEqual(exits, [])
})

test('what the journal says about an order', () => {
  const begun = beginEffects({}, [REQ, REQ2], { now: T0 })
  assert.equal(unresolvedEffects(begun.metadata).length, 2, 'an intent in flight is unresolved')
  assert.equal(hasRecordedEffect(begun.metadata), true)
  const j = readJournal(begun.metadata)
  const a = recordEffectOutcome(begun.metadata, REQ.key, j[REQ.key].intentId, { state: 'not_sent', cause: 'econnrefused', message: 'x' }, { now: T0 })
  const b = recordEffectOutcome(a.metadata, REQ2.key, j[REQ2.key].intentId, { state: 'rejected', cause: 'http_422', message: 'x' }, { now: T0 })
  assert.equal(hasUnresolvedEffect(b.metadata), false)
  assert.equal(hasRecordedEffect(b.metadata), false, 'provably nothing was done')
  assert.equal(hasRecordedEffect({}), false)
  assert.ok(describeEffect(REQ.key, readJournal(begun.metadata)[REQ.key]).includes('being sent'))
  const unknown = recordEffectOutcome(begun.metadata, REQ.key, j[REQ.key].intentId, { state: 'uncertain', cause: 'timeout', message: 'x' }, { now: T0 })
  assert.ok(describeEffect(REQ.key, readJournal(unknown.metadata)[REQ.key]).includes('OUTCOME UNKNOWN'))
})

test('a damaged journal never reads as "nothing happened"', () => {
  const journal = readJournal({ externalEffects: {
    a: { kind: 'printlab_submit', state: 'weird', intentId: 'i' },
    b: { kind: 'unknown_kind', state: 'confirmed' },
    c: 'garbage',
    d: { kind: 'stockworks_movement' },
  } })
  assert.equal(journal.a.state, 'uncertain')
  assert.equal(journal.a.cause, 'unreadable_record')
  assert.equal(journal.b, undefined, 'a kind we do not know is not ours to interpret')
  assert.equal(journal.c, undefined)
  assert.equal(journal.d.state, 'uncertain')
  for (const metadata of [null, undefined, 'x', 5, [], { externalEffects: 'x' }, { externalEffects: [] }]) assert.deepEqual(readJournal(metadata), {})
})

// ---- classification -------------------------------------------------------------------------------------------------------------------------
function networkError(innerCode?: string, innerName = 'Error') {
  const inner: any = Object.assign(new Error('connect failed'), { name: innerName })
  if (innerCode) inner.code = innerCode
  const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: inner })
  return Object.assign(new Error('Unable to reach the service'), { status: 502, cause: fetchFailed, networkFailure: true })
}
const answer = (status: number, payload: unknown = { error: 'x' }) => Object.assign(new Error(`status ${status}`), { status, payload })

test('classification: the request never left', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
    const c = classifyExternalFailure(networkError(code))
    assert.equal(c.state, 'not_sent', code)
    assert.equal(c.httpStatus, null)
  }
})

test('classification: the service refused (4xx) - it did nothing', () => {
  for (const status of [400, 401, 403, 404, 405, 413, 415, 422, 429]) {
    const c = classifyExternalFailure(answer(status))
    assert.equal(c.state, 'rejected', String(status))
    assert.equal(c.httpStatus, status)
  }
  assert.equal(classifyExternalFailure(answer(422, null)).state, 'rejected', 'an unreadable body is still an answer')
})

test('classification: anything that may have been done is uncertain', () => {
  for (const status of [409, 408, 500, 502, 503, 504, 301, 302]) assert.equal(classifyExternalFailure(answer(status)).state, 'uncertain', String(status))
  assert.equal(classifyExternalFailure(answer(409)).cause, 'conflict')
  assert.equal(classifyExternalFailure(answer(503)).cause, 'server_error')
  for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ETIMEDOUT']) {
    const c = classifyExternalFailure(networkError(code))
    assert.equal(c.state, 'uncertain', code)
    assert.equal(c.cause, 'connection_lost')
  }
  for (const name of ['TimeoutError', 'AbortError']) {
    const c = classifyExternalFailure(networkError(undefined, name))
    assert.equal(c.state, 'uncertain', name)
    assert.equal(c.cause, 'timeout')
  }
  assert.equal(classifyExternalFailure(new Error('who knows')).state, 'uncertain')
  assert.equal(classifyExternalFailure('a string').state, 'uncertain')
  assert.equal(classifyExternalFailure(null).state, 'uncertain')
  assert.equal(classifyExternalFailure(undefined).state, 'uncertain')
  assert.equal(BAD_RESPONSE.state, 'uncertain')
})

test('classification: a "502" made up by our own client for a dead connection is not an answer of the service', () => {
  // lib/printlab.ts and lib/stockworks-client.ts wrap a failed fetch in an error with status 502: that is a network failure, not an HTTP answer
  const wrapped = Object.assign(new Error('Unable to reach PrintLab'), { status: 502, cause: new Error('socket hang up'), networkFailure: true })
  const c = classifyExternalFailure(wrapped)
  assert.equal(c.state, 'uncertain')
  assert.equal(c.cause, 'connection_lost')
  assert.equal(c.httpStatus, null)
})

test('classification: a request the HTTP client itself refuses to send (a forbidden port) never left; a similar-sounding failure is not that', () => {
  // undici refuses before any connection is made: the message is "bad port" (found by a test that aimed at port 1)
  const badPort = Object.assign(new Error('Unable to reach the service'), { status: 502, networkFailure: true, cause: Object.assign(new TypeError('fetch failed'), { cause: new Error('bad port') }) })
  const refused = classifyExternalFailure(badPort)
  assert.equal(refused.state, 'not_sent')
  assert.equal(refused.cause, 'bad_port')
  // the same kind of wrapper around a failure that may have happened AFTER the request left stays uncertain
  for (const message of ['socket hang up', 'bad port number in the answer', 'Bad Gateway', 'other side closed']) {
    const lost = Object.assign(new Error('Unable to reach the service'), { status: 502, networkFailure: true, cause: Object.assign(new TypeError('fetch failed'), { cause: new Error(message) }) })
    assert.equal(classifyExternalFailure(lost).state, 'uncertain', message)
  }
})
