// Step 4.6, S6 (P3b-1, F02) - which payment attempts of an order can be ASKED about, and what the answers allow one to say (lib/payment-attempt-legs.ts). Pure: no database, no network,
// no clock, no environment.
//
// THE DEFECT (F02). `readChargeEvidence` of lib/payment-hold.ts skipped an attempt that has neither a Stripe session id nor a Stripe payment intent id and, if nothing else showed money or
// failed, answered "no money" - and the decision "no charge" then recorded `confirmed_no_charge`: a confirmation that nobody had asked Stripe for. An attempt with no identifier is NOT
// evidence that nothing was charged: nothing can be asked about it. These tests fix the contract of the pure part that replaces that rule:
//   * classifyAttemptLegs: an attempt is READABLE only if it carries a well-formed Stripe identifier; anything else - absent, blank, malformed, not a string, a row that contradicts a twin
//     row with the same id - is not verifiable, and never "repaired" into a readable channel;
//   * combineLegEvidence: money anywhere wins; otherwise a channel with no identifier, a read that failed, or a readable channel with NO outcome is "unknown"; only when every channel
//     was asked and showed no money is the answer "none";
//   * snapshotAttempts / attemptSetsMatch: the set of attempts that was examined is kept as an immutable copy and compared with the set found under the lock of the order (so that a
//     decision is never taken on an examination that no longer covers the attempts of the order).
// Nothing here reads Stripe: the Stripe side (the reads, the decision, the lock) is proved by tests/security/payment-hold.sec.ts with a fake Stripe and a throw-away database.
// Written BEFORE the module existed (red), green after. The module is loaded lazily on purpose, so that each test fails on its own when it is missing.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { stripComments } from './_source-scan'

type Mod = typeof import('../lib/payment-attempt-legs')
let loaded: Promise<Mod> | null = null
const load = (): Promise<Mod> => (loaded ??= import('../lib/payment-attempt-legs'))

const ROOT = process.cwd()
const SESSION = 'cs_test_a1B2c3D4'
const SESSION_2 = 'cs_test_FAKE_2'
const INTENT = 'pi_3Nabc123_XYZ'
const INTENT_2 = 'pi_test_FAKE_2'

type Row = Record<string, unknown>
const attempt = (id: string, over: Row = {}): Row => ({ id, stripeSessionId: null, stripePaymentIntentId: null, status: 'open', ...over })
const classify = async (attempts: unknown) => (await load()).classifyAttemptLegs(attempts as never)
const basisOf = async (row: unknown) => (await classify([row]))[0].basis
const combine = async (legs: unknown, reads: unknown) => (await load()).combineLegEvidence(legs as never, reads as never)
const reads = (entries: Array<[string, string]>) => new Map<string, string>(entries)
const readable = (attemptId: string) => ({ attemptId, basis: 'stripe_readable' as const })
const idless = (attemptId: string) => ({ attemptId, basis: 'no_stripe_identifier' as const })

// ---- L1-L8: the classification --------------------------------------------------------------------------------------------------------------------------------------------
test('L1-L3 an attempt with a well-formed Stripe session id, or payment intent id, or both, can be asked about', async () => {
  assert.equal(await basisOf(attempt('a1', { stripeSessionId: SESSION })), 'stripe_readable')
  assert.equal(await basisOf(attempt('a2', { stripePaymentIntentId: INTENT })), 'stripe_readable')
  assert.equal(await basisOf(attempt('a3', { stripeSessionId: SESSION, stripePaymentIntentId: INTENT })), 'stripe_readable')
  // the identifier that is not there may be absent in any of the ways an absent identifier is: null, undefined, empty - or no property at all
  for (const absent of [null, undefined, ''] as unknown[]) {
    assert.equal(await basisOf(attempt('a4', { stripeSessionId: SESSION, stripePaymentIntentId: absent })), 'stripe_readable', `payment intent id ${JSON.stringify(absent) ?? 'undefined'}`)
    assert.equal(await basisOf(attempt('a5', { stripeSessionId: absent, stripePaymentIntentId: INTENT })), 'stripe_readable', `session id ${JSON.stringify(absent) ?? 'undefined'}`)
  }
  assert.equal(await basisOf({ id: 'a6', stripeSessionId: SESSION }), 'stripe_readable', 'no payment intent property at all')
  assert.equal(await basisOf({ id: 'a7', stripePaymentIntentId: INTENT }), 'stripe_readable', 'no session property at all')
})

test('L4-L6 an attempt with NO identifier - null, undefined, empty or missing - is not verifiable, whatever its status, reason or expiry (no exception)', async () => {
  const ABSENT: unknown[] = [null, undefined, '']
  for (const session of ABSENT) {
    for (const intent of ABSENT) {
      assert.equal(await basisOf(attempt('a', { stripeSessionId: session, stripePaymentIntentId: intent })), 'no_stripe_identifier', `${String(session)}/${String(intent)}`)
    }
  }
  assert.equal(await basisOf({ id: 'a' }), 'no_stripe_identifier', 'the properties are missing altogether')
  // F02 has NO exceptions in this package: not an expired reservation, not a failure with a reason, not a closed attempt, not a long-past expiry
  const WHY: Row[] = [
    { status: 'creating' }, { status: 'expired', failureReason: 'stale_reservation' }, { status: 'failed', failureReason: 'StripeInvalidRequestError:parameter_invalid_integer' },
    { status: 'failed', failureReason: 'session_mismatch:amount' }, { status: 'failed', failureReason: 'open_without_session' }, { status: 'open', expiresAt: new Date(0) },
    { status: 'paid' }, { status: 'processing' }, { status: 'mismatch' },
  ]
  for (const over of WHY) assert.equal(await basisOf(attempt('a', over)), 'no_stripe_identifier', JSON.stringify(over))
})

test('L7 a value that is neither a string nor absent is PRESENT and never valid: it is not repaired into "no identifier", and it never leaves a readable channel behind', async () => {
  const NOT_STRINGS: unknown[] = [5, 0, true, false, {}, [], ['cs_x'], () => 'cs_x', 10n, Symbol('x'), new String(SESSION), { id: SESSION }]
  for (const value of NOT_STRINGS) {
    assert.equal(await basisOf(attempt('a', { stripeSessionId: value })), 'no_stripe_identifier', `session ${typeof value}`)
    assert.equal(await basisOf(attempt('a', { stripePaymentIntentId: value })), 'no_stripe_identifier', `intent ${typeof value}`)
    // a junk session id next to a good payment intent id is NOT turned into a channel that is read through the payment intent
    assert.equal(await basisOf(attempt('a', { stripeSessionId: value, stripePaymentIntentId: INTENT })), 'no_stripe_identifier', `junk session ${typeof value} + good intent`)
    assert.equal(await basisOf(attempt('a', { stripeSessionId: SESSION, stripePaymentIntentId: value })), 'no_stripe_identifier', `good session + junk intent ${typeof value}`)
  }
})

test('L8 one leg per attempt, in the order given, carrying the attempt id; nothing is invented, merged or dropped', async () => {
  assert.deepEqual(await classify([]), [])
  const input = [attempt('c', { stripeSessionId: SESSION }), attempt('a'), attempt('b', { stripePaymentIntentId: INTENT }), attempt('d')]
  assert.deepEqual(await classify(input), [readable('c'), idless('a'), readable('b'), idless('d')])
  // the same input twice gives the same answer; the input is not touched
  const frozen = Object.freeze(input.map((row) => Object.freeze({ ...row })))
  assert.deepEqual(await classify(frozen), await classify(input))
  assert.deepEqual(input.map((row) => row.id), ['c', 'a', 'b', 'd'])
})

test('L12 an identifier that is not shaped like a Stripe one is not a channel: blanks, other prefixes, the other field\'s prefix, foreign characters, a length that no id has', async () => {
  const BAD_SESSIONS = [' ', '  ', 'cs_', 'cs', 'x', 'null', 'undefined', '[object Object]', 'pi_wrong_field', 'ch_x', 'cs_has-hyphen', 'cs_has space', 'cs_new\nline', ` ${SESSION}`, `${SESSION} `, 'cs_é', `cs_${'a'.repeat(256)}`, 'CS_upper', `x${SESSION}`, `pi_${SESSION}`]
  for (const value of BAD_SESSIONS) assert.equal(await basisOf(attempt('a', { stripeSessionId: value })), 'no_stripe_identifier', JSON.stringify(value))
  const BAD_INTENTS = [' ', 'pi_', 'pi', 'y', 'cs_wrong_field', 'pi_has-hyphen', 'pi_has space', `pi_${'a'.repeat(256)}`, 'PI_upper', `${INTENT}\n`, ` ${INTENT}`, `x${INTENT}`, `cs_${INTENT}`]
  for (const value of BAD_INTENTS) assert.equal(await basisOf(attempt('a', { stripePaymentIntentId: value })), 'no_stripe_identifier', JSON.stringify(value))
  // the longest well-formed identifiers are channels
  assert.equal(await basisOf(attempt('a', { stripeSessionId: `cs_${'a'.repeat(255)}` })), 'stripe_readable')
  assert.equal(await basisOf(attempt('a', { stripePaymentIntentId: `pi_${'Z'.repeat(255)}` })), 'stripe_readable')
  // an attempt that has no id of its own cannot be told apart from another: it is not verifiable even with good Stripe identifiers
  for (const id of ['', null, undefined, 7, {}] as unknown[]) assert.equal(await basisOf({ id, stripeSessionId: SESSION }), 'no_stripe_identifier', `attempt id ${String(id)}`)
})

test('L13 the same attempt id described in two different ways is a contradiction: none of its legs is a verified channel; the same description twice is just a repeat', async () => {
  const twins = await classify([attempt('a', { stripeSessionId: SESSION }), attempt('a', { stripeSessionId: SESSION_2 })])
  assert.deepEqual(twins, [idless('a'), idless('a')])
  assert.deepEqual(await classify([attempt('a', { stripeSessionId: SESSION }), attempt('a', { stripeSessionId: SESSION, stripePaymentIntentId: INTENT })]), [idless('a'), idless('a')])
  assert.deepEqual(await classify([attempt('a', { stripeSessionId: SESSION }), attempt('a', { stripeSessionId: SESSION, status: 'paid' })]), [idless('a'), idless('a')], 'a different status is a contradiction too')
  assert.deepEqual(await classify([attempt('a'), attempt('a', { stripeSessionId: SESSION })]), [idless('a'), idless('a')])
  assert.deepEqual(await classify([attempt('a', { stripeSessionId: SESSION }), attempt('a', { stripeSessionId: SESSION })]), [readable('a'), readable('a')], 'an exact repeat is not a contradiction')
  // a contradiction about one id does not spoil the others
  assert.deepEqual(await classify([attempt('a', { stripeSessionId: SESSION }), attempt('b', { stripeSessionId: SESSION_2 }), attempt('a', { stripeSessionId: INTENT })]), [idless('a'), readable('b'), idless('a')])
})

test('L14 data that is not what the contract says never makes a readable channel, and never throws: a container that is not a list, rows that are not objects, getters that throw, revoked proxies', async () => {
  for (const container of [null, undefined, 5, 'abc', {}, { length: 1, 0: attempt('a', { stripeSessionId: SESSION }) }, new Set([attempt('a', { stripeSessionId: SESSION })])] as unknown[]) {
    const legs = await classify(container)
    assert.ok(legs.length >= 1 && legs.every((leg) => leg.basis === 'no_stripe_identifier'), `container ${Object.prototype.toString.call(container)} must leave no readable channel and not look like "no attempts"`)
  }
  // (an array that carries the properties of an attempt is still an array, not a row)
  const arrayWithTheFields = Object.assign([], { id: 'a', stripeSessionId: SESSION, stripePaymentIntentId: null, status: 'open' })
  for (const row of [null, undefined, 5, 'cs_x', true, [], [attempt('a', { stripeSessionId: SESSION })], arrayWithTheFields, () => attempt('a', { stripeSessionId: SESSION })] as unknown[]) {
    const legs = await classify([row, attempt('b', { stripeSessionId: SESSION })])
    assert.equal(legs.length, 2, `a row that is ${typeof row} still takes its place`)
    assert.equal(legs[0].basis, 'no_stripe_identifier')
    assert.deepEqual(legs[1], readable('b'), 'its neighbours are judged on their own')
  }
  const throwing = { id: 'a', get stripeSessionId(): string { throw new Error('boom') }, stripePaymentIntentId: INTENT }
  assert.equal(await basisOf(throwing), 'no_stripe_identifier')
  const throwingId = { get id(): string { throw new Error('boom') }, stripeSessionId: SESSION }
  assert.equal(await basisOf(throwingId), 'no_stripe_identifier')
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  assert.equal(await basisOf(revoked.proxy), 'no_stripe_identifier')
  const hostileList = new Proxy([attempt('a', { stripeSessionId: SESSION })], { get(target, key, receiver) { if (key === '0' || key === 'length') throw new Error('boom'); return Reflect.get(target, key, receiver) } })
  const legs = await classify(hostileList)
  assert.ok(legs.length >= 1 && legs.every((leg) => leg.basis === 'no_stripe_identifier'), 'a list that cannot be read leaves no readable channel')
})

// ---- L9: the combination -----------------------------------------------------------------------------------------------------------------------------------------------
test('L9 combining the legs with what Stripe answered: money wins; a leg with no identifier, a failed read or a missing outcome is "unknown"; only all-asked-and-no-money is "none"', async () => {
  const CASES: Array<{ name: string; legs: unknown; reads: unknown; verdict: string; withoutIdentifier: number; unreadable: number }> = [
    { name: 'no attempts at all (vacuous: the route refuses an order without attempts before it asks anything)', legs: [], reads: reads([]), verdict: 'none', withoutIdentifier: 0, unreadable: 0 },
    { name: 'one channel, asked, no money', legs: [readable('a')], reads: reads([['a', 'no_money']]), verdict: 'none', withoutIdentifier: 0, unreadable: 0 },
    { name: 'three channels, all asked, no money', legs: [readable('a'), readable('b'), readable('c')], reads: reads([['a', 'no_money'], ['b', 'no_money'], ['c', 'no_money']]), verdict: 'none', withoutIdentifier: 0, unreadable: 0 },
    { name: 'one channel with money', legs: [readable('a')], reads: reads([['a', 'money']]), verdict: 'money', withoutIdentifier: 0, unreadable: 0 },
    { name: 'a channel with NO identifier (F02): nothing can be said', legs: [idless('a')], reads: reads([]), verdict: 'unknown', withoutIdentifier: 1, unreadable: 0 },
    { name: 'a channel that was asked and showed no money, and one with no identifier', legs: [readable('a'), idless('b')], reads: reads([['a', 'no_money']]), verdict: 'unknown', withoutIdentifier: 1, unreadable: 0 },
    { name: 'the same two, the other way round', legs: [idless('b'), readable('a')], reads: reads([['a', 'no_money']]), verdict: 'unknown', withoutIdentifier: 1, unreadable: 0 },
    { name: 'a read that failed is "unreadable", never "no money"', legs: [readable('a')], reads: reads([['a', 'unreadable']]), verdict: 'unknown', withoutIdentifier: 0, unreadable: 1 },
    { name: 'a channel with an identifier and NO outcome stays unverifiable', legs: [readable('a')], reads: reads([]), verdict: 'unknown', withoutIdentifier: 0, unreadable: 1 },
    { name: 'an outcome that is not one of the three is not "no money"', legs: [readable('a')], reads: reads([['a', 'none']]), verdict: 'unknown', withoutIdentifier: 0, unreadable: 1 },
    { name: 'money found on one channel wins over a channel with no identifier (CHARGE_EXISTS, not a generic refusal)', legs: [readable('a'), idless('b')], reads: reads([['a', 'money']]), verdict: 'money', withoutIdentifier: 1, unreadable: 0 },
    { name: 'money wins over a failed read, in either order', legs: [readable('a'), readable('b')], reads: reads([['a', 'unreadable'], ['b', 'money']]), verdict: 'money', withoutIdentifier: 0, unreadable: 1 },
    { name: 'money wins over a missing outcome', legs: [readable('a'), readable('b')], reads: reads([['b', 'money']]), verdict: 'money', withoutIdentifier: 0, unreadable: 1 },
    { name: 'two failed reads and one without identifier are counted', legs: [readable('a'), readable('b'), idless('c')], reads: reads([['a', 'unreadable'], ['b', 'unreadable']]), verdict: 'unknown', withoutIdentifier: 1, unreadable: 2 },
    { name: 'an outcome for a leg that has no identifier does not make it verifiable; money there still blocks', legs: [idless('a')], reads: reads([['a', 'no_money']]), verdict: 'unknown', withoutIdentifier: 1, unreadable: 0 },
    { name: 'money reported for a leg without identifier blocks (the safe direction)', legs: [idless('a')], reads: reads([['a', 'money']]), verdict: 'money', withoutIdentifier: 1, unreadable: 0 },
    { name: 'an exact repeat of a readable leg is one more asked channel', legs: [readable('a'), readable('a')], reads: reads([['a', 'no_money']]), verdict: 'none', withoutIdentifier: 0, unreadable: 0 },
    { name: 'outcomes of attempts that are not among the legs say nothing about them', legs: [readable('a')], reads: reads([['a', 'unreadable'], ['stranger', 'no_money']]), verdict: 'unknown', withoutIdentifier: 0, unreadable: 1 },
    { name: 'a stranger\'s outcome does not make an unasked channel "none"', legs: [readable('a')], reads: reads([['stranger', 'no_money']]), verdict: 'unknown', withoutIdentifier: 0, unreadable: 1 },
  ]
  for (const entry of CASES) {
    const result = await combine(entry.legs, entry.reads)
    assert.deepEqual(result, { verdict: entry.verdict, withoutIdentifier: entry.withoutIdentifier, unreadable: entry.unreadable }, entry.name)
  }
})

test('L15 combining never trusts what is not in the contract: legs that are not a list, a twin id with two bases, unknown bases, outcomes that are not a Map or that throw', async () => {
  const UNKNOWN = { verdict: 'unknown', withoutIdentifier: 0, unreadable: 0 }
  for (const legs of [null, undefined, 5, 'abc', {}, new Set([readable('a')])] as unknown[]) {
    const result = await combine(legs, reads([['a', 'no_money']]))
    assert.equal(result.verdict, 'unknown', `legs ${Object.prototype.toString.call(legs)}`)
  }
  assert.deepEqual(await combine(null, reads([])), UNKNOWN)
  // one attempt id that appears with two bases is a contradiction: not a verified channel
  assert.equal((await combine([readable('a'), idless('a')], reads([['a', 'no_money']]))).verdict, 'unknown')
  assert.equal((await combine([idless('a'), readable('a')], reads([['a', 'no_money']]))).verdict, 'unknown')
  assert.equal((await combine([readable('a'), idless('a')], reads([['a', 'money']]))).verdict, 'money')
  // ... and BOTH of its descriptions are legs that cannot be asked about (the count says so)
  assert.deepEqual(await combine([readable('a'), idless('a')], reads([['a', 'no_money']])), { verdict: 'unknown', withoutIdentifier: 2, unreadable: 0 })
  assert.deepEqual(await combine([idless('a'), readable('a')], reads([['a', 'no_money']])), { verdict: 'unknown', withoutIdentifier: 2, unreadable: 0 })
  // a list of legs that cannot be read (a getter that throws, a revoked proxy) is not "no legs"
  const hostileLegs = new Proxy([readable('a')], { get(target, key, receiver) { if (key === '0' || key === 'length') throw new Error('boom'); return Reflect.get(target, key, receiver) } })
  assert.deepEqual(await combine(hostileLegs, reads([['a', 'no_money']])), UNKNOWN)
  const revokedLegs = Proxy.revocable([readable('a')], {})
  revokedLegs.revoke()
  assert.deepEqual(await combine(revokedLegs.proxy, reads([['a', 'no_money']])), UNKNOWN)
  // a leg that cannot be read is a leg that cannot be asked about: no outcome filed under an empty attempt id vouches for it
  const throwingLeg = { get attemptId(): string { throw new Error('boom') }, basis: 'stripe_readable' }
  assert.deepEqual(await combine([throwingLeg], reads([['', 'no_money']])), { verdict: 'unknown', withoutIdentifier: 1, unreadable: 0 })
  // a leg that is not a leg, a basis that is not one of the two, an empty attempt id: not verifiable
  for (const leg of [null, undefined, 5, 'a', {}, { attemptId: 'a' }, { attemptId: 'a', basis: 'verified' }, { attemptId: 'a', basis: 'STRIPE_READABLE' }, { attemptId: '', basis: 'stripe_readable' }, { attemptId: 7, basis: 'stripe_readable' }]) {
    const result = await combine([leg], reads([['a', 'no_money'], ['', 'no_money']]))
    assert.equal(result.verdict, 'unknown', JSON.stringify(leg) ?? String(leg))
    assert.ok(result.withoutIdentifier >= 1)
  }
  // outcomes that are not a Map, or that cannot be read, say nothing: a readable channel stays unverifiable
  for (const outcomes of [null, undefined, 5, {}, { a: 'no_money' }, { get: 5 }, [['a', 'no_money']]] as unknown[]) {
    const result = await combine([readable('a')], outcomes)
    assert.equal(result.verdict, 'unknown', `outcomes ${Object.prototype.toString.call(outcomes)}`)
    assert.equal(result.unreadable, 1)
  }
  const throwing = { get(): string { throw new Error('boom') } }
  assert.equal((await combine([readable('a')], throwing)).verdict, 'unknown')
  // the outcomes are never changed by the combination
  const outcomes = reads([['a', 'no_money'], ['b', 'unreadable']])
  const before = [...outcomes.entries()]
  await combine([readable('a'), readable('b')], outcomes)
  assert.deepEqual([...outcomes.entries()], before)
})

// ---- the snapshot and the comparison under the lock --------------------------------------------------------------------------------------------------------------------------
const row = (id: string, session: string | null, intent: string | null, status = 'open', extra: Row = {}): Row => ({ id, stripeSessionId: session, stripePaymentIntentId: intent, status, ...extra })

test('L16 the snapshot is an immutable copy of what was examined: id, session id, payment intent id and status - and nothing else, nothing shared with the rows', async () => {
  const mod = await load()
  const rows = [row('a', SESSION, null, 'processing', { amountCents: 100, failureReason: 'x', updatedAt: new Date(), metadata: { secret: 1 } }), row('b', null, INTENT, 'open')]
  const snapshot = mod.snapshotAttempts(rows as never)
  assert.deepEqual(snapshot.map((entry) => ({ ...entry })), [
    { id: 'a', stripeSessionId: SESSION, stripePaymentIntentId: null, status: 'processing' },
    { id: 'b', stripeSessionId: null, stripePaymentIntentId: INTENT, status: 'open' },
  ])
  assert.ok(Object.isFrozen(snapshot) && snapshot.every((entry) => Object.isFrozen(entry)), 'frozen, the list and each entry')
  // a later change of the rows does not reach the snapshot, and a change of the snapshot is refused
  rows[0].stripeSessionId = 'cs_changed'
  rows[0].status = 'paid'
  rows.push(row('c', SESSION_2, null))
  assert.equal(snapshot[0].stripeSessionId, SESSION)
  assert.equal(snapshot[0].status, 'processing')
  assert.equal(snapshot.length, 2)
  assert.throws(() => { (snapshot[0] as { status: string }).status = 'paid' }, TypeError)
  assert.throws(() => { (snapshot as unknown as unknown[]).push(1) }, TypeError)
  // it classifies like the rows it was made from
  assert.deepEqual(mod.classifyAttemptLegs(snapshot), mod.classifyAttemptLegs([row('a', SESSION, null, 'processing'), row('b', null, INTENT)] as never))
})

test('L17 a value that is not a string does not become "absent" in the snapshot (that would turn junk next to a good id into a readable channel); a container that is not a list leaves a non-verifiable placeholder', async () => {
  const mod = await load()
  const junk = mod.snapshotAttempts([row('a', 5 as never, INTENT)] as never)
  assert.notEqual(junk[0].stripeSessionId, null, 'present, not absent')
  assert.equal(mod.classifyAttemptLegs(junk)[0].basis, 'no_stripe_identifier')
  assert.equal(mod.classifyAttemptLegs([row('a', 5 as never, INTENT)] as never)[0].basis, 'no_stripe_identifier')
  const blank = mod.snapshotAttempts([row('a', '', null)] as never)
  assert.equal(blank[0].stripeSessionId, null, 'an empty string is an absent id, as in the code before P3b-1')
  for (const container of [null, undefined, 5, 'abc', {}] as unknown[]) {
    const placeholder = mod.snapshotAttempts(container as never)
    assert.ok(placeholder.length >= 1)
    assert.ok(mod.classifyAttemptLegs(placeholder).every((leg) => leg.basis === 'no_stripe_identifier'))
    assert.equal(mod.attemptSetsMatch(placeholder, placeholder), false, 'a placeholder is never "the same set"')
  }
  assert.equal(mod.snapshotAttempts([] as never).length, 0)
})

test('L18 the comparison under the lock: the same set matches, in any order; an insertion, a deletion, a changed id, a changed status or a replacement with the same COUNT does not', async () => {
  const mod = await load()
  const base = [row('a', SESSION, null, 'processing'), row('b', null, INTENT, 'open'), row('c', null, null, 'creating')]
  const verified = mod.snapshotAttempts(base as never)
  const same = (current: unknown) => mod.attemptSetsMatch(verified, current as never)
  assert.equal(same(base), true)
  assert.equal(same([...base].reverse()), true, 'the order of the rows is not part of the set')
  assert.equal(same(base.map((entry) => ({ ...entry, updatedAt: new Date(), failureReason: 'x', expiresAt: new Date(1), amountCents: 9 }))), true, 'columns that are not examined do not count')
  // an attempt appears (with no identifier: the case of C1)
  assert.equal(same([...base, row('d', null, null, 'creating')]), false, 'insertion without identifiers')
  assert.equal(same([...base, row('d', SESSION_2, null, 'open')]), false, 'insertion with an identifier')
  // an attempt disappears
  assert.equal(same(base.slice(1)), false, 'deletion')
  assert.equal(same([]), false, 'all deleted')
  // an identifier changes
  assert.equal(same([row('a', SESSION_2, null, 'processing'), base[1], base[2]]), false, 'session id changed')
  assert.equal(same([row('a', null, null, 'processing'), base[1], base[2]]), false, 'session id removed')
  assert.equal(same([base[0], row('b', null, INTENT_2), base[2]]), false, 'payment intent id changed')
  assert.equal(same([base[0], base[1], row('c', null, INTENT, 'creating')]), false, 'an identifier appeared on the attempt that had none')
  // the status changes
  assert.equal(same([row('a', SESSION, null, 'paid'), base[1], base[2]]), false, 'processing -> paid')
  assert.equal(same([base[0], base[1], row('c', null, null, 'expired')]), false, 'creating -> expired')
  // same count, different attempts (C3): one replaced by another
  assert.equal(same([base[0], base[1], row('z', null, null, 'creating')]), false, 'one attempt replaced by another with another id')
  assert.equal(same([base[0], base[1], row('c', SESSION_2, null, 'open')]), false, 'one attempt replaced in place')
  assert.equal(same([base[0], base[0], base[1]]), false, 'a row repeated in the place of another (same count, one id twice)')
})

test('L19 the comparison is conservative with data it cannot trust: lists that are not lists, a row with no id of its own, an id that appears twice - on either side - never match', async () => {
  const mod = await load()
  const base = [row('a', SESSION, null), row('b', null, INTENT)]
  const verified = mod.snapshotAttempts(base as never)
  for (const current of [null, undefined, 5, 'abc', {}] as unknown[]) assert.equal(mod.attemptSetsMatch(verified, current as never), false, Object.prototype.toString.call(current))
  for (const earlier of [null, undefined, 5, {}] as unknown[]) assert.equal(mod.attemptSetsMatch(earlier as never, base as never), false)
  assert.equal(mod.attemptSetsMatch([] as never, [] as never), true, 'nothing examined and nothing found is the same set')
  assert.equal(mod.attemptSetsMatch([] as never, base as never), false)
  // two things that are not lists are not "the same set", and neither is one of them next to an empty list
  const NOT_LISTS: unknown[] = [null, undefined, 5, 'abc', {}]
  for (const earlier of NOT_LISTS) {
    for (const later of NOT_LISTS) assert.equal(mod.attemptSetsMatch(earlier as never, later as never), false, `${Object.prototype.toString.call(earlier)} / ${Object.prototype.toString.call(later)}`)
    assert.equal(mod.attemptSetsMatch(earlier as never, [] as never), false, `${Object.prototype.toString.call(earlier)} / []`)
    assert.equal(mod.attemptSetsMatch([] as never, earlier as never), false, `[] / ${Object.prototype.toString.call(earlier)}`)
  }
  // a row without an id of its own cannot be compared: not even with itself
  const nameless = [row('a', SESSION, null), { stripeSessionId: SESSION_2, stripePaymentIntentId: null, status: 'open' }]
  assert.equal(mod.attemptSetsMatch(mod.snapshotAttempts(nameless as never), nameless as never), false)
  // an id twice: not a set
  const twice = [row('a', SESSION, null), row('a', SESSION, null)]
  assert.equal(mod.attemptSetsMatch(mod.snapshotAttempts(twice as never), twice as never), false)
  assert.equal(mod.attemptSetsMatch(verified, [...base, row('a', SESSION, null)] as never), false)
  // a row that throws when it is read cannot be compared
  const throwing = { id: 'a', get stripeSessionId(): string { throw new Error('boom') }, stripePaymentIntentId: null, status: 'open' }
  assert.equal(mod.attemptSetsMatch(verified, [throwing, base[1]] as never), false)
  // the comparison does not change what it is given
  const current = Object.freeze(base.map((entry) => Object.freeze({ ...entry })))
  assert.equal(mod.attemptSetsMatch(verified, current as never), true)
})

// ---- purity, totality, determinism ---------------------------------------------------------------------------------------------------------------------------------------
test('L20 pure and total: frozen inputs are accepted, outputs are fresh and independent, the same input gives the same answer, nothing throws on any shape', async () => {
  const mod = await load()
  const rows = Object.freeze([Object.freeze(row('a', SESSION, null)), Object.freeze(row('b', null, null, 'creating'))])
  const first = mod.classifyAttemptLegs(rows as never)
  const second = mod.classifyAttemptLegs(rows as never)
  assert.deepEqual(first, second)
  assert.notEqual(first, second, 'a new list each time')
  first[0].basis = 'no_stripe_identifier'
  assert.equal(mod.classifyAttemptLegs(rows as never)[0].basis, 'stripe_readable', 'changing an answer does not change the next one')
  const outcomes = new Map([['a', 'no_money']])
  assert.deepEqual(mod.combineLegEvidence(second, outcomes as never), mod.combineLegEvidence(second, outcomes as never))
  assert.equal(JSON.stringify(mod.snapshotAttempts(rows as never)), JSON.stringify(mod.snapshotAttempts(rows as never)))
  const SHAPES: unknown[] = [undefined, null, 0, 1, NaN, '', 'x', true, [], [[]], [null], [undefined], {}, { length: 3 }, () => 1, Symbol('s'), 10n, new Date(0), new Map(), new Set(), /x/, Object.create(null)]
  for (const shape of SHAPES) {
    assert.doesNotThrow(() => mod.classifyAttemptLegs(shape as never), `classify ${String(typeof shape)}`)
    assert.doesNotThrow(() => mod.combineLegEvidence(shape as never, shape as never))
    assert.doesNotThrow(() => mod.combineLegEvidence([shape] as never, shape as never))
    assert.doesNotThrow(() => mod.snapshotAttempts(shape as never))
    assert.doesNotThrow(() => mod.attemptSetsMatch(shape as never, shape as never))
  }
})

// ---- L10: the monotony, differentially, on seeded random worlds ------------------------------------------------------------------------------------------------------------
type Random = () => number
function mulberry32(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]

// the rule of the code BEFORE P3b-1 (lib/payment-hold.ts at 5d1e866, readChargeEvidence): an attempt with neither id was skipped, money anywhere made the answer "money", a read that
// failed made it "unknown", and the rest was "none". (A missing outcome did not exist then; here it is a read that did not succeed.)
function oldVerdict(attempts: Row[], outcomes: Map<string, string>): 'money' | 'none' | 'unknown' {
  let unknown = false
  for (const entry of attempts) {
    if (!entry.stripeSessionId && !entry.stripePaymentIntentId) continue
    const outcome = outcomes.get(entry.id as string)
    if (outcome === 'money') return 'money'
    if (outcome !== 'no_money') unknown = true
  }
  return unknown ? 'unknown' : 'none'
}
const WORLDS = Math.max(200, Number(process.env.ATTEMPT_LEGS_WORLDS) || 4000)

test(`L10 differential monotony on ${WORLDS} seeded worlds: the new rule NEVER allows what the old one refused; money is never lost; on well-formed data it differs only by turning "none" into "unknown" when an attempt has no identifier`, async () => {
  const mod = await load()
  const IDS = ['a', 'b', 'c', 'd']
  const SESSIONS: unknown[] = [null, undefined, '', SESSION, SESSION_2, 'cs_x1', 'x', ' ', 'cs_', 'pi_wrong_field', 5, {}, 'cs_has-hyphen']
  const INTENTS: unknown[] = [null, undefined, '', INTENT, INTENT_2, 'pi_x1', 'y', 'cs_wrong_field', 0, []]
  const STATUSES = ['creating', 'open', 'processing', 'paid', 'mismatch', 'failed', 'expired']
  const OUTCOMES = ['money', 'no_money', 'unreadable', undefined]
  let improvedRefusals = 0
  let sameVerdicts = 0
  for (let seed = 1; seed <= WORLDS; seed++) {
    const random = mulberry32(seed)
    const attempts: Row[] = []
    const count = Math.floor(random() * 6)
    for (let index = 0; index < count; index++) {
      attempts.push({ id: pick(random, IDS), stripeSessionId: pick(random, SESSIONS), stripePaymentIntentId: pick(random, INTENTS), status: pick(random, STATUSES) })
    }
    const legs = mod.classifyAttemptLegs(attempts as never)
    assert.equal(legs.length, attempts.length, `seed ${seed}: one leg per attempt`)
    // Stripe is asked only about the legs that can be asked about (that is what the payment hold does): only they have an outcome, or a missing one
    const outcomes = new Map<string, string>()
    for (const leg of legs) {
      if (leg.basis !== 'stripe_readable' || outcomes.has(leg.attemptId)) continue
      const outcome = pick(random, OUTCOMES)
      if (outcome !== undefined) outcomes.set(leg.attemptId, outcome)
    }
    const next = mod.combineLegEvidence(legs, outcomes as never).verdict
    const old = oldVerdict(attempts, outcomes)
    // 1. the new rule allows only what the old one allowed
    if (next === 'none') assert.equal(old, 'none', `seed ${seed}: the new rule allowed what the old refused: ${JSON.stringify(attempts)} ${JSON.stringify([...outcomes])}`)
    // 2. money that the old rule saw is money for the new one
    if (old === 'money') assert.equal(next, 'money', `seed ${seed}: money lost`)
    // 3. a refusal of the old rule stays a refusal
    if (old !== 'none') assert.notEqual(next, 'none', `seed ${seed}`)
    // 4. the snapshot classifies like the rows
    assert.deepEqual(mod.classifyAttemptLegs(mod.snapshotAttempts(attempts as never)), legs, `seed ${seed}: snapshot`)
    // 5. a set always matches its own snapshot when its ids are distinct and non-empty
    const distinct = new Set(attempts.map((entry) => entry.id)).size === attempts.length
    assert.equal(mod.attemptSetsMatch(mod.snapshotAttempts(attempts as never), attempts as never), distinct, `seed ${seed}: own snapshot`)
    // 6. on well-formed data (unique ids, each identifier valid or absent) the difference is exactly the F02 one
    const wellFormed = distinct && attempts.every((entry) => {
      const session = entry.stripeSessionId
      const intent = entry.stripePaymentIntentId
      return (session === null || session === undefined || session === '' || session === SESSION || session === SESSION_2 || session === 'cs_x1')
        && (intent === null || intent === undefined || intent === '' || intent === INTENT || intent === INTENT_2 || intent === 'pi_x1')
    })
    if (wellFormed) {
      const hasIdless = attempts.some((entry) => !entry.stripeSessionId && !entry.stripePaymentIntentId)
      const expected = old === 'money' ? 'money' : hasIdless ? 'unknown' : old
      assert.equal(next, expected, `seed ${seed}: ${JSON.stringify(attempts)} ${JSON.stringify([...outcomes])}`)
    }
    if (old === 'none' && next === 'unknown') improvedRefusals++
    if (old === next) sameVerdicts++
  }
  // the worlds are not all trivial: some turn "none" into "unknown", many are unchanged
  assert.ok(improvedRefusals > 0, 'no world exercised the F02 case')
  assert.ok(sameVerdicts > 0, 'no world was left unchanged')
})

// ---- L11: the guards of the source -------------------------------------------------------------------------------------------------------------------------------------------
const readSource = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      out.push(...sourceFiles(rel))
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(rel)
  }
  return out
}

test('L11 the module is pure by construction: no import, no I/O, no clock, no environment, no randomness, no state between calls; it names neither the funds model nor the reader', async () => {
  const raw = readSource('lib/payment-attempt-legs.ts')
  const code = stripComments(raw)
  assert.ok(!/^\s*import\b/m.test(code) && !/\brequire\s*\(/.test(code) && !/\bimport\s*\(/.test(code) && !/\bexport\s+(\*|\{[^}]*\})\s+from\b/.test(code), 'no import of any kind')
  for (const word of ['Date', 'performance', 'process', 'Math.random', 'crypto', 'fetch', 'XMLHttpRequest', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'console', 'fs', 'prisma', 'stripe', 'Stripe', 'globalThis', 'window', 'document', 'localStorage', 'await', 'async', 'Promise']) {
    assert.ok(!new RegExp(`(^|[^A-Za-z0-9_$.])${word.replace('.', '\\.')}([^A-Za-z0-9_$]|$)`).test(code.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")), `the module must not use ${word}`)
  }
  assert.ok(!/^(let|var)\s/m.test(code), 'no mutable declaration at the top level of the module (no state between calls)')
  // the two isolation guards of the other packages forbid these words ANYWHERE, comments included
  assert.ok(!raw.includes('payment-hold-evidence'), 'the funds model is isolated: nothing may name it')
  assert.ok(!raw.includes('stripe-funds-reader'), 'the reader is isolated: nothing may name it')
  // the obsolete shortcut of F01 stays out of every file of the application, comments included (tests/production-release-guards.test.ts, G13)
  assert.ok(!/acknowledgeUnverified|unreachable_acknowledged|STRIPE_UNREACHABLE/.test(raw))
  // the surface is fixed: a change here is a decision
  const surface = Object.keys((await load()) as Record<string, unknown>).sort()
  assert.deepEqual(surface, ['ATTEMPT_LEG_BASES', 'attemptSetsMatch', 'classifyAttemptLegs', 'combineLegEvidence', 'snapshotAttempts'])
})

test('L11b the bases are a fixed, frozen list', async () => {
  const mod = await load()
  assert.deepEqual([...mod.ATTEMPT_LEG_BASES], ['stripe_readable', 'no_stripe_identifier'])
  assert.ok(Object.isFrozen(mod.ATTEMPT_LEG_BASES))
})

// Only the payment hold uses the module (it is verified in isolation otherwise): a package that wants another user changes this list on purpose.
const ALLOWED_IMPORTERS = ['lib/payment-hold.ts']
test('L21 only lib/payment-hold.ts names the module; the funds model and the reader stay unknown to the payment hold; the Stripe calls of the hold are exactly the four that it made before', () => {
  const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map((entry) => entry.name)
  const files = [...rootFiles, ...['app', 'lib', 'components', 'scripts', 'prisma'].filter((dir) => fs.existsSync(path.join(ROOT, dir))).flatMap((dir) => sourceFiles(dir))]
  const MODULE_FILE = path.join('lib', 'payment-attempt-legs.ts')
  assert.deepEqual(files.filter((file) => file !== MODULE_FILE && readSource(file).includes('payment-attempt-legs')).sort(), ALLOWED_IMPORTERS)
  const hold = readSource('lib/payment-hold.ts')
  assert.ok(!hold.includes('payment-hold-evidence') && !hold.includes('stripe-funds-reader'))
  // no new call to Stripe, no write: the reads and the closing of a page that were there
  const calls = [...stripComments(hold).matchAll(/\b(?:stripe|getStripe\(\))\.([A-Za-z.]+)\(/g)].map((match) => match[1]).sort()
  assert.deepEqual(calls, ['checkout.sessions.expire', 'checkout.sessions.retrieve', 'paymentIntents.retrieve', 'paymentIntents.retrieve'])
  // the decision no longer has a way to say "none" that does not come from the combination of what was asked
  assert.ok(stripComments(hold).includes('combineLegEvidence('), 'readChargeEvidence combines the legs with the answers')
  assert.ok(!/return\s+'none'/.test(stripComments(hold)), 'no literal "none" is returned by the payment hold')
  // every part of the module is used where it is needed: what is read is the examined COPY of the attempts (made before Stripe is asked), it is classified, the answers are combined,
  // and the set is compared under the lock
  for (const name of ['snapshotAttempts', 'classifyAttemptLegs', 'combineLegEvidence', 'attemptSetsMatch']) {
    assert.ok(new RegExp(`\\b${name}\\(`).test(stripComments(hold)), `the payment hold calls ${name}`)
  }
  // ... and the decision goes on only when the answer is exactly "none" (any other answer refuses)
  assert.ok(/evidence\.verdict\s*!==\s*'none'/.test(stripComments(hold)), 'only "none" lets the decision go on')
})
