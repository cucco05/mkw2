// R1-3 / KLOSS, P3 - the adapter of the confirmation of a repeat purchase (lib/checkout-owner-guard.ts), without a database: the flag and its combinations with the owner guard, the value of a context,
// the acceptance an order keeps (and that it touches no financial fact), the proposal and who is told what, and the judgement each door asks - for an order that is about to be made and for an order
// that exists (audit point A: the value of the first is never taken for the value of the second; the acceptance written with a new order is checked by what it records, not by its value).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptanceHolds, acceptanceOf, acceptanceRecord, CART_FINGERPRINT_VERSION, existingOrderSubject, judgeRepeatForNew, judgeRepeatForOrder, newOrderSubject, NO_REPEAT, ownerGuardMode,
  REPEAT_CONTEXT_PATTERN, repeatContextValue, repeatGuardMode, repeatMembersDigest, repeatProposalResponse, requestedRepeatGuardMode, withAcceptance,
  type RepeatAcceptance, type SubjectOrder,
} from '../lib/checkout-owner-guard'
import { financialEvents, FINANCIAL_PREV_SELECT } from '../lib/financial-revision'
import { REPEAT_CONFIRMATION_CODE, REPEAT_CONFIRMATION_MESSAGE, repeatContextOf, type OwnerEvidence, type RepeatMember } from '../lib/owner-intent'

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const HASH_A = 'a'.repeat(64)
const CART = 'c'.repeat(64)
const cookie: OwnerEvidence = { kind: 'guest', sessionHash: HASH_A, verifiedOrders: [{ id: 'o_paid', guestSessionHash: HASH_A }, { id: 'o_wait', guestSessionHash: HASH_A }] }
const sessionOnly: OwnerEvidence = { kind: 'guest', sessionHash: HASH_A, verifiedOrders: [] }
const account: OwnerEvidence = { kind: 'account', userId: 'user_1' }
const member = (orderId: string, financialRevision: number, over: Partial<RepeatMember> = {}): RepeatMember => ({ orderId, orderNumber: 7, financialRevision, proof: 'access', verifiedAtMs: NOW - 5 * MIN, createdAtMs: NOW - 9 * MIN, ...over })
const totals = { amount: 5700, currencyCode: 'EUR', itemsTotalCents: 5000, shippingAmountCents: 700, taxCents: 0 }
const order = (over: Partial<SubjectOrder> = {}): SubjectOrder => ({
  id: 'o_wait', orderNumber: 12, userId: null, guestSessionHash: HASH_A, financialRevision: 0, totalCents: 5700, currency: 'EUR', shippingCents: 700, taxCents: 0,
  metadata: { source: 'stripe_checkout', checkout: { version: 1, fingerprint: 'f'.repeat(64), cartFingerprint: CART, lines: [] } }, items: [{ totalCents: 2500 }, { totalCents: 2500 }], ...over,
})
const on = { mode: 'on' as const, value: null }
const withEnv = (vars: Record<string, string | undefined>, run: () => void) => {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(vars)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  try { run() } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}

test('P3 flag: CHECKOUT_REPEAT_GUARD is off unless it says shadow or on, and it never applies more than the owner guard does', () => {
  for (const [raw, asked] of [[undefined, 'off'], ['', 'off'], ['off', 'off'], ['true', 'off'], ['1', 'off'], ['onn', 'off'], ['ON', 'on'], [' on ', 'on'], ['Shadow', 'shadow']] as const) {
    withEnv({ CHECKOUT_REPEAT_GUARD: raw }, () => assert.equal(requestedRepeatGuardMode(), asked, JSON.stringify(raw)))
  }
  // [CHECKOUT_OWNER_GUARD, CHECKOUT_REPEAT_GUARD, what applies] - the table of PLAN REV2 (D-3)
  const table: Array<[string | undefined, string | undefined, string]> = [
    [undefined, 'on', 'off'], ['off', 'on', 'off'], ['off', 'shadow', 'off'],
    ['shadow', 'off', 'off'], ['shadow', 'shadow', 'shadow'], ['shadow', 'on', 'shadow'],
    ['on', 'off', 'off'], ['on', undefined, 'off'], ['on', 'shadow', 'shadow'], ['on', 'on', 'on'],
  ]
  for (const [owner, repeat, effective] of table) {
    withEnv({ CHECKOUT_OWNER_GUARD: owner, CHECKOUT_REPEAT_GUARD: repeat }, () => {
      assert.equal(repeatGuardMode(), effective, `owner=${owner} repeat=${repeat}`)
      assert.equal(repeatGuardMode(ownerGuardMode()), effective)
    })
  }
})

test('P3 the value of a context: rc1_ and a SHA-256, the same for the same context in any order, different when any field differs', () => {
  const members = [member('o_b', 2), member('o_a', 1)]
  const ctx = repeatContextOf({ owner: cookie, cart: { v: CART_FINGERPRINT_VERSION, fp: CART }, subject: newOrderSubject(totals), members })
  const value = repeatContextValue(ctx)
  assert.match(value, REPEAT_CONTEXT_PATTERN)
  assert.equal(repeatContextValue(repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject(totals), members: [...members].reverse() })), value)
  const others = [
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject({ ...totals, amount: 5701 }), members }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject({ ...totals, taxCents: 1 }), members }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject({ ...totals, shippingAmountCents: 701 }), members }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject({ ...totals, itemsTotalCents: 4999 }), members }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject({ ...totals, currencyCode: 'USD' }), members }),
    repeatContextOf({ owner: cookie, cart: { v: 3, fp: CART }, subject: newOrderSubject(totals), members }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: 'd'.repeat(64) }, subject: newOrderSubject(totals), members }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject(totals), members: [member('o_b', 3), member('o_a', 1)] }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject(totals), members: [member('o_b', 2)] }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject(totals), members: [...members, member('o_c', 0)] }),
    repeatContextOf({ owner: account, cart: { v: 2, fp: CART }, subject: newOrderSubject(totals), members }),
    repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: existingOrderSubject(order()), members }),
  ].map(repeatContextValue)
  assert.equal(new Set([value, ...others]).size, others.length + 1, 'every field takes part in the value')
  // the digest of G alone is another value (another label): a value of a context is never a digest of G
  assert.notEqual(repeatMembersDigest(members), value.slice(4))
  assert.equal(repeatMembersDigest(members), repeatMembersDigest([...members].reverse()))
})

test('P3 the acceptance: written into metadata.checkout beside what is there, read back strictly, and it touches NO financial fact (the revision does not move)', () => {
  const members = [member('o_paid', 3)]
  const record = acceptanceRecord({ members, rev: 0, context: `rc1_${'e'.repeat(64)}`, now: new Date(NOW) })
  assert.deepEqual(record, { repeatOf: ['o_paid'], repeatAcceptance: { v: 1, g: repeatMembersDigest(members), n: 1, rev: 0, context: `rc1_${'e'.repeat(64)}`, via: 'access', at: new Date(NOW).toISOString() } })
  const before = order({ metadata: { source: 'stripe_checkout', checkout: { version: 1, fingerprint: 'f'.repeat(64), cartFingerprint: CART, lines: [{ title: 'x' }] }, stripe: { paymentStatus: 'pending' }, paymentReview: [] } })
  const after = withAcceptance(before.metadata, record)
  assert.deepEqual(after, { ...(before.metadata as object), checkout: { ...((before.metadata as any).checkout), repeatOf: ['o_paid'], repeatAcceptance: record.repeatAcceptance } })
  assert.deepEqual(acceptanceOf(after), record.repeatAcceptance)
  // what the registry of financial facts says about this write: nothing - no revision, no event (lib/financial-revision.ts)
  const prev = Object.fromEntries(Object.keys(FINANCIAL_PREV_SELECT).map((key) => [key, (before as any)[key] ?? null]))
  assert.deepEqual(financialEvents({ ...prev, metadata: before.metadata }, { metadata: after }), [])
  // read back strictly: anything that is not exactly an acceptance is none
  const valid = record.repeatAcceptance
  const broken: Array<Partial<Record<keyof RepeatAcceptance, unknown>>> = [{ v: 2 }, { g: 'x' }, { n: 0 }, { n: 1.5 }, { rev: -1 }, { rev: '0' }, { context: 'rc1_short' }, { via: 'session' }, { at: 5 }]
  for (const patch of broken) assert.equal(acceptanceOf({ checkout: { repeatAcceptance: { ...valid, ...patch } } }), null, JSON.stringify(patch))
  for (const metadata of [null, undefined, [], 'x', {}, { checkout: null }, { checkout: [] }, { checkout: { repeatAcceptance: [] } }]) assert.equal(acceptanceOf(metadata), null, JSON.stringify(metadata))
})

test('P3 an acceptance HOLDS while G is the same set with the same revisions and the order keeps the revision it was accepted at', () => {
  const members = [member('o_paid', 3), member('o_old', 1)]
  const accepted = acceptanceRecord({ members, rev: 4, context: `rc1_${'e'.repeat(64)}` }).repeatAcceptance
  assert.equal(acceptanceHolds(accepted, members, 4), true)
  assert.equal(acceptanceHolds(accepted, [...members].reverse(), 4), true, 'the same set, read in another order')
  assert.equal(acceptanceHolds(accepted, members, 5), false, 'the order moved (its money situation changed)')
  assert.equal(acceptanceHolds(accepted, [member('o_paid', 4), member('o_old', 1)], 4), false, 'a member changed its money situation')
  assert.equal(acceptanceHolds(accepted, [member('o_paid', 3)], 4), false, 'a member left G')
  assert.equal(acceptanceHolds(accepted, [...members, member('o_new', 0)], 4), false, 'a payment was verified since')
  assert.equal(acceptanceHolds(accepted, [], 4), false, 'with no G there is nothing to hold')
  assert.equal(acceptanceHolds(null, members, 4), false)
})

test('P3 the proposal: the newest paid order named, the count, the value; a waiting order is said to exist, and is named only to who proves it with the cookie or the account', () => {
  const proposal = { newest: member('o_paid', 3, { orderNumber: 41 }), count: 2, value: `rc1_${'e'.repeat(64)}`, pending: null }
  const fresh = repeatProposalResponse(proposal, cookie)
  assert.deepEqual(fresh, { status: 409, code: REPEAT_CONFIRMATION_CODE, message: REPEAT_CONFIRMATION_MESSAGE, extra: { orderId: 'o_paid', orderNumber: 41, repeatCount: 2, repeatContext: proposal.value } })
  const waitingUnnamed = repeatProposalResponse({ ...proposal, pending: { orderId: 'o_wait', orderNumber: 12, named: false } }, cookie)
  assert.deepEqual(waitingUnnamed.extra, { orderId: 'o_paid', orderNumber: 41, repeatCount: 2, repeatContext: proposal.value, pendingOrder: true })
  const waitingNamed = repeatProposalResponse({ ...proposal, pending: { orderId: 'o_wait', orderNumber: 12, named: true } }, cookie)
  assert.deepEqual(waitingNamed.extra, { orderId: 'o_paid', orderNumber: 41, repeatCount: 2, repeatContext: proposal.value, pendingOrder: true, pendingOrderId: 'o_wait', pendingOrderNumber: 12 })
  // a proposal that would name an order proved by less than the cookie or the account is a programming error: it throws instead of saying a word too many
  assert.throws(() => repeatProposalResponse({ ...proposal, newest: member('o_paid', 3, { proof: 'session' as never }) }, sessionOnly), TypeError)
})

test('P3 the judgement for an order about to be made: off and shadow go on; with G only the value of THIS context makes it, and with its acceptance', () => {
  const members = [member('o_paid', 3)]
  const value = repeatContextValue(repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject(totals), members }))
  assert.deepEqual(judgeRepeatForNew({ evidence: cookie, members, totals, cart: CART, repeat: NO_REPEAT }), { kind: 'go' })
  assert.deepEqual(judgeRepeatForNew({ evidence: cookie, members, totals, cart: CART, repeat: { mode: 'shadow', value } }), { kind: 'go' }, 'a shadow never asks and never keeps')
  assert.deepEqual(judgeRepeatForNew({ evidence: cookie, members: [], totals, cart: CART, repeat: { mode: 'on', value } }), { kind: 'go' }, 'no G: nothing to confirm, nothing kept')
  const confirmed = judgeRepeatForNew({ evidence: cookie, members, totals, cart: CART, repeat: { mode: 'on', value } })
  assert.equal(confirmed.kind, 'create_with')
  if (confirmed.kind === 'create_with') assert.deepEqual({ ...confirmed.acceptance.repeatAcceptance, at: 'at' }, { v: 1, g: repeatMembersDigest(members), n: 1, rev: 0, context: value, via: 'access', at: 'at' })
  for (const sent of [null, `rc1_${'0'.repeat(64)}`, repeatContextValue(repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject({ ...totals, amount: 5800 }), members }))]) {
    assert.deepEqual(judgeRepeatForNew({ evidence: cookie, members, totals, cart: CART, repeat: { mode: 'on', value: sent } }), { kind: 'propose', proposal: { newest: members[0], count: 1, value, pending: null } }, String(sent))
  }
})

test('P3 the judgement for an order that exists (audit A): its own context decides - the value given for the order before it existed does not; the acceptance it was made with holds without any value', () => {
  const members = [member('o_paid', 3)]
  const newValue = repeatContextValue(repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: newOrderSubject(totals), members }))
  const fresh = order()
  const orderValue = repeatContextValue(repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: existingOrderSubject(fresh), members }))
  assert.notEqual(newValue, orderValue, 'two contexts: the order about to be made, and the order made')
  // the order made by a confirmed request carries its acceptance (revision 0): the next door goes on with NO value at all
  const made = order({ metadata: withAcceptance(fresh.metadata, acceptanceRecord({ members, rev: 0, context: newValue })) })
  assert.deepEqual(judgeRepeatForOrder({ evidence: cookie, members, order: made, cart: CART, repeat: on, stage: 'page' }), { kind: 'go' })
  // ...until its context changes: G (a payment verified since), or the revision of the order - then only the value of ITS context goes on, and is kept
  const later = [member('o_new', 0), ...members]
  const stale = judgeRepeatForOrder({ evidence: cookie, members: later, order: made, cart: CART, repeat: { mode: 'on', value: newValue }, stage: 'page' })
  assert.equal(stale.kind, 'propose', 'the value of the order before it existed confirms nothing about the order')
  const valueNow = repeatContextValue(repeatContextOf({ owner: cookie, cart: { v: 2, fp: CART }, subject: existingOrderSubject(made), members: later }))
  if (stale.kind === 'propose') assert.deepEqual(stale.proposal, { newest: later[0], count: 2, value: valueNow, pending: { orderId: 'o_wait', orderNumber: 12, named: true } })
  const recorded = judgeRepeatForOrder({ evidence: cookie, members: later, order: made, cart: CART, repeat: { mode: 'on', value: valueNow }, stage: 'page' })
  assert.equal(recorded.kind, 'record')
  if (recorded.kind === 'record') assert.deepEqual({ ...recorded.acceptance.repeatAcceptance, at: 'at' }, { v: 1, g: repeatMembersDigest(later), n: 2, rev: 0, context: valueNow, via: 'access', at: 'at' })
  const moved = order({ ...made, financialRevision: 1 })
  assert.equal(judgeRepeatForOrder({ evidence: cookie, members, order: moved, cart: CART, repeat: on, stage: 'page' }).kind, 'propose', 'the order changed its money situation since it was accepted')
  // S2 and S3 compute the same context for the same order and request: the value proposed at one door is the value accepted at the other
  const fromOrderDoor = judgeRepeatForOrder({ evidence: cookie, members, order: fresh, cart: CART, repeat: on, stage: 'order' })
  const fromPageDoor = judgeRepeatForOrder({ evidence: cookie, members, order: fresh, cart: CART, repeat: on, stage: 'page' })
  assert.ok(fromOrderDoor.kind === 'propose' && fromPageDoor.kind === 'propose' && fromOrderDoor.proposal.value === fromPageDoor.proposal.value && fromPageDoor.proposal.value === orderValue)
  // no G: nothing; off or shadow: nothing - and none of them ever writes
  assert.deepEqual(judgeRepeatForOrder({ evidence: cookie, members: [], order: fresh, cart: CART, repeat: { mode: 'on', value: orderValue }, stage: 'page' }), { kind: 'go' })
  assert.deepEqual(judgeRepeatForOrder({ evidence: cookie, members, order: fresh, cart: CART, repeat: { mode: 'shadow', value: orderValue }, stage: 'page' }), { kind: 'go' })
  assert.deepEqual(judgeRepeatForOrder({ evidence: cookie, members, order: fresh, cart: CART, repeat: NO_REPEAT, stage: 'page' }), { kind: 'go' })
  // the waiting order is named only to who proves IT strongly: here a browser session alone made it
  const notOpened: OwnerEvidence = { kind: 'guest', sessionHash: HASH_A, verifiedOrders: [{ id: 'o_paid', guestSessionHash: HASH_A }] }
  const unnamed = judgeRepeatForOrder({ evidence: notOpened, members, order: fresh, cart: CART, repeat: on, stage: 'page' })
  assert.ok(unnamed.kind === 'propose' && unnamed.proposal.pending?.named === false)
})
