// Step 4.6, S6 (P1) - the POSITION OF THE FUNDS of ONE Stripe payment (lib/payment-hold-evidence.ts). A pure function: whole cents, no database, no network, no clock, no environment.
//
// What these tests are, and are not.
//   * They prove the MODEL: how the amounts of a payment, of its refunds and of its disputes are counted, what is kept apart (fees), and what is called "proven" or "uncertain".
//   * The objects below are BUILT HERE, shaped after what the Stripe SDK documents and after what the owner's two Test Mode runs OBSERVED (SP1 run a9488563; AR-2 run 685b014d:
//     docs/VERIFICA-4.6.md S6a.17 and S6a.18). They are fixtures, not Stripe answers: nothing here was fetched from Stripe, and no test calls Stripe.
//   * What is OBSERVED in Test Mode (cited in the names): a pending refund is already inside `amount_refunded` (T16A: 20 while pending, 20 after succeeded); a refund that SUCCEEDED can
//     FAIL later and `amount_refunded` goes back down (T16B: 20 -> 0), with a refund balance transaction of -20 and a failure balance transaction of +20, both with fee 0; a dispute
//     withdraws the disputed amount with a SEPARATE fee (SP1: -100 with a fee of 2000 on a payment of 1.00, net -2100), a won dispute reinstates the amount and the fee is not given
//     back; `Charge.disputed` stays true after a win (T9).
//   * What is PRUDENCE of the project, not observation: `requires_action` and `canceled` refunds were never seen (AR-2), the statuses `warning_*` and `prevented` of a dispute were never
//     seen, the exact `reporting_category` values of the balance transactions of a dispute are taken from Stripe's public documentation (the sanitized SP1 report was not available to this
//     package). Each is handled so that it can never grant anything.
//   * Written BEFORE the module existed (red), green after. The module is loaded lazily on purpose, so that each test fails on its own when it is missing.
//   * Section 16 and the stronger invariants of `assertWellFormed` were added AFTER the first passes of mutation testing had shown rules that nothing guarded; what was run, and the
//     mutations that cannot be detected because they change nothing (equivalent), is in docs/VERIFICA-4.6.md S6a.19.
//   * Section 17 (P1-bis) was written FIRST, red, after an independent audit of ae71c32 found two defects of financial behavior (docs/VERIFICA-4.6.md S6a.20): (A) a refund id named by
//     a request and by Stripe, or by two requests, with two different amounts was reconciled quietly; (B) "is nothing held?" was answered 'yes' for a zero that rests on a refund that
//     succeeded and can still fail. Exactly two expectations written before the audit changed with it, and each says why: the test of the total refund in section 2, and the title of
//     the test of the hand-written positions in section 16. The invariants of `assertWellFormed` got two stricter lines (finality of a zero; a request that counts is said).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type Stripe from 'stripe'
import type {
  BalanceTransactionEvidence, ChargeEvidence, DisputeEvidence, FundsEvidence, FundsFinding, FundsPosition, PaymentIntentEvidence, RefundEvidence,
} from '../lib/payment-hold-evidence'
import { stripComments } from './_source-scan'

type Mod = typeof import('../lib/payment-hold-evidence')
let loaded: Promise<Mod> | null = null
const load = (): Promise<Mod> => (loaded ??= import('../lib/payment-hold-evidence'))
const compute = async (evidence: unknown): Promise<FundsPosition> => (await load()).computeFundsPosition(evidence as FundsEvidence)

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------------------------------------
const PI = 'pi_test_1'
const CH = 'ch_test_1'
const pi = (over: Record<string, unknown> = {}) => ({ id: PI, amount: 100, amount_received: 100, currency: 'eur', status: 'succeeded', latest_charge: CH, ...over })
const charge = (over: Record<string, unknown> = {}) => ({ id: CH, amount: 100, amount_captured: 100, amount_refunded: 0, currency: 'eur', disputed: false, payment_intent: PI, ...over })
// 'omit' leaves has_more out, as a list that does not say whether there is more ("undefined" would take the default)
const list = (data: unknown[], hasMore: boolean | 'omit' = false) => ({ data, ...(hasMore === 'omit' ? {} : { has_more: hasMore }) })
const bt = (over: Record<string, unknown> = {}) => ({ id: 'txn_1', amount: 0, currency: 'eur', fee: 0, net: 0, type: 'adjustment', reporting_category: 'dispute', source: 'dp_1', ...over })
// a refund as Stripe reports it; its balance transaction is the one of its own amount (a pending refund has none yet)
const refund = (over: Record<string, unknown> = {}) => {
  const id = (over.id as string | undefined) ?? 're_1'
  const amount = (over.amount as number | undefined) ?? 20
  const status = (over.status as string | undefined) ?? 'succeeded'
  const own = status === 'pending' || status === 'requires_action' ? null : bt({ id: `txn_${id}`, amount: -amount, fee: 0, net: -amount, type: 'refund', reporting_category: 'refund', source: id })
  return { id, amount, currency: 'eur', status, payment_intent: PI, charge: CH, balance_transaction: own, failure_balance_transaction: null, ...over }
}
// the same refund after it FAILED: the money left (-amount) and came back (+amount), both with fee 0 (AR-2, scenario B)
const failedRefund = (over: Record<string, unknown> = {}) => {
  const id = (over.id as string | undefined) ?? 're_1'
  const amount = (over.amount as number | undefined) ?? 20
  return refund({
    id, amount, status: 'failed', failure_reason: 'expired_or_canceled_card',
    failure_balance_transaction: bt({ id: `txn_f_${id}`, amount, fee: 0, net: amount, type: 'refund_failure', reporting_category: 'refund_failure', source: id }), ...over,
  })
}
const withdrawal = (amount = 100, fee = 2000, over: Record<string, unknown> = {}) => bt({ id: 'txn_dp_w', amount: -amount, fee, net: -amount - fee, reporting_category: 'dispute', ...over })
const reinstatement = (amount = 100, fee = 0, over: Record<string, unknown> = {}) => bt({ id: 'txn_dp_r', amount, fee, net: amount - fee, reporting_category: 'dispute_reversal', ...over })
const dispute = (over: Record<string, unknown> = {}) => ({ id: 'dp_1', amount: 100, currency: 'eur', status: 'lost', payment_intent: PI, charge: CH, balance_transactions: [withdrawal()], ...over })
const ev = (over: Record<string, unknown> = {}) => ({ paymentIntent: pi(), charge: charge(), refunds: list([]), disputes: list([]), ...over })
// evidence with refunds: the charge reports `reported` as refunded (default: the sum of the succeeded ones)
const withRefunds = (refunds: unknown[], reported: number | null = 0, over: Record<string, unknown> = {}) => ev({ refunds: list(refunds), charge: charge({ amount_refunded: reported }), ...over })
// evidence with a dispute: the charge says it is disputed
const withDisputes = (disputes: unknown[], over: Record<string, unknown> = {}) => ev({ disputes: list(disputes), charge: charge({ disputed: true }), ...over })

const finding = (position: FundsPosition, code: string): FundsFinding | undefined => position.findings.find((entry) => entry.code === code)
const codesOf = (position: FundsPosition, kind?: string): string[] => position.findings.filter((entry) => !kind || entry.kind === kind).map((entry) => String(entry.code)).sort()
const allCodes = (position: FundsPosition) => position.findings.map((entry) => `${entry.kind}:${entry.code}`).sort()
function bounds(position: FundsPosition, lower: number, upper: number | null, label = '') {
  assert.equal(position.retainedLowerCents, lower, `${label} lower bound`)
  assert.equal(position.retainedUpperCents, upper, `${label} upper bound`)
}
const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

// =====================================================================================================================================================================
// 1. A verified payment, nothing refunded, nothing disputed - and what is NOT a collected payment
// =====================================================================================================================================================================
test('a collected payment with nothing refunded and nothing disputed: the capital is all there, proven, and the whole output is exactly this', async () => {
  const position = await compute(ev())
  assert.deepEqual(position, {
    currency: 'eur', certainty: 'proven', final: true, collectedCents: 100, retainedLowerCents: 100, retainedUpperCents: 100, retainedCents: 100, overRecoveredCents: 0, provisionalRefundCents: 0,
    refunds: { confirmedCents: 0, inFlightCents: 0, unknownCents: 0, requestedCents: 0, reversedCents: 0, reportedByChargeCents: 0, items: [] },
    disputes: { withdrawnCents: 0, reinstatedCents: 0, fundsGoneLowerCents: 0, fundsGoneUpperCents: 0, items: [] },
    fees: { disputeCents: 0, refundCents: 0, totalCents: 0, complete: true },
    findings: [],
  })
  const { retainedAtLeast, retainedIsZero } = await load()
  assert.equal(retainedAtLeast(position, 100), 'yes')
  assert.equal(retainedAtLeast(position, 101), 'no')
  assert.equal(retainedAtLeast(position, 0), 'yes')
  assert.equal(retainedIsZero(position), 'no')
})

test('the capital is what was RECEIVED, not what was asked for (a partial capture), and the currency is read in lower case', async () => {
  const position = await compute(ev({ paymentIntent: pi({ amount: 100, amount_received: 60, currency: 'EUR' }), charge: charge({ amount: 100, amount_captured: 60, currency: 'EUR' }) }))
  assert.equal(position.collectedCents, 60)
  assert.equal(position.retainedCents, 60)
  assert.equal(position.currency, 'eur')
  assert.equal(position.certainty, 'proven')
})

// `upper` is the most that can be held: 0 for a payment that was canceled, none (null) for money that may still arrive or whose amount is not known
const PAYMENT_STATUS_CASES: Array<{ name: string; status: unknown; collected: number | null; upper: number | null; certainty: 'proven' | 'uncertain'; code: string | null; final: boolean }> = [
  { name: 'canceled: nothing was ever collected, and that is final', status: 'canceled', collected: 0, upper: 0, certainty: 'proven', code: null, final: true },
  { name: 'requires_payment_method: nothing collected yet, but money may still arrive', status: 'requires_payment_method', collected: 0, upper: null, certainty: 'uncertain', code: 'payment_open', final: false },
  { name: 'requires_confirmation: same', status: 'requires_confirmation', collected: 0, upper: null, certainty: 'uncertain', code: 'payment_open', final: false },
  { name: 'requires_action: same', status: 'requires_action', collected: 0, upper: null, certainty: 'uncertain', code: 'payment_open', final: false },
  { name: 'processing: money is on its way, the amount is not known', status: 'processing', collected: null, upper: null, certainty: 'uncertain', code: 'payment_in_motion', final: false },
  { name: 'requires_capture: authorized, not collected', status: 'requires_capture', collected: null, upper: null, certainty: 'uncertain', code: 'payment_in_motion', final: false },
  { name: 'a status nobody knows', status: 'brand_new_status', collected: null, upper: null, certainty: 'uncertain', code: 'payment_status_unknown', final: false },
  { name: 'a status in capital letters is not a status: nothing is guessed', status: 'Succeeded', collected: null, upper: null, certainty: 'uncertain', code: 'payment_status_unknown', final: false },
  { name: 'no status', status: undefined, collected: null, upper: null, certainty: 'uncertain', code: 'payment_status_unknown', final: false },
  { name: 'a null status', status: null, collected: null, upper: null, certainty: 'uncertain', code: 'payment_status_unknown', final: false },
  { name: 'a status that is not a text', status: 7, collected: null, upper: null, certainty: 'uncertain', code: 'payment_status_unknown', final: false },
]
for (const scenario of PAYMENT_STATUS_CASES) {
  test(`payment status - ${scenario.name}`, async () => {
    const position = await compute(ev({ paymentIntent: pi({ status: scenario.status, amount_received: 0 }), charge: charge({ amount_captured: 0 }) }))
    assert.equal(position.collectedCents, scenario.collected)
    bounds(position, 0, scenario.upper)
    assert.equal(position.certainty, scenario.certainty)
    assert.equal(position.final, scenario.final)
    if (scenario.code) assert.ok(codesOf(position, 'uncertainty').includes(scenario.code), allCodes(position).join(', '))
    else assert.deepEqual(allCodes(position), [])
    // money that has not been seen to arrive is never "money held"
    const { retainedAtLeast, retainedIsZero } = await load()
    assert.notEqual(retainedAtLeast(position, 1), 'yes')
    assert.equal(retainedAtLeast(position, 1), scenario.upper === 0 ? 'no' : 'unknown', 'only "nothing at all" is certain; money that may still arrive is not "less than 1"')
    if (scenario.certainty === 'uncertain') assert.equal(retainedIsZero(position), 'unknown', 'absence of the proof that money arrived is not the proof that there is none')
    else assert.equal(retainedIsZero(position), 'yes')
  })
}

// =====================================================================================================================================================================
// 2. Refunds: partial, total, more than collected
// =====================================================================================================================================================================
const REFUND_AMOUNT_CASES: Array<{ name: string; refunds: unknown[]; reported: number; confirmed: number; retained: number; over: number }> = [
  { name: 'a partial refund of 0.30', refunds: [refund({ id: 're_p', amount: 30 })], reported: 30, confirmed: 30, retained: 70, over: 0 },
  { name: 'two refunds, 0.30 and 0.20', refunds: [refund({ id: 're_a', amount: 30 }), refund({ id: 're_b', amount: 20 })], reported: 50, confirmed: 50, retained: 50, over: 0 },
  { name: 'a total refund', refunds: [refund({ id: 're_t', amount: 100 })], reported: 100, confirmed: 100, retained: 0, over: 0 },
  { name: 'more refunded than collected: reported as over-recovered, never a negative balance', refunds: [refund({ id: 're_x', amount: 120 })], reported: 120, confirmed: 120, retained: 0, over: 20 },
]
for (const scenario of REFUND_AMOUNT_CASES) {
  test(`refunds - ${scenario.name}`, async () => {
    const position = await compute(withRefunds(scenario.refunds, scenario.reported))
    assert.equal(position.refunds.confirmedCents, scenario.confirmed)
    bounds(position, scenario.retained, scenario.retained)
    assert.equal(position.retainedCents, scenario.retained)
    assert.equal(position.overRecoveredCents, scenario.over)
    assert.equal(position.certainty, 'proven', allCodes(position).join(', '))
    // a succeeded refund may still fail later: the amount is "refunded now", never "refunded for good"
    assert.equal(position.provisionalRefundCents, scenario.confirmed)
    assert.equal(position.final, false)
    assert.deepEqual(codesOf(position, 'anomaly'), scenario.over > 0 ? ['over_recovered'] : [])
  })
}

// CHANGED EXPECTATION (P1-bis, defect B). This test used to assert `retainedIsZero(position) === 'yes'` for a total refund that succeeded. An independent audit of ae71c32 showed that
// this lets a future, irreversible decision rest on a refund that AR-2 B showed can still FAIL after it succeeded (the money comes back, the capital is whole again). The position
// still SHOWS zero (that is the snapshot); the question "is nothing held?" now says 'yes' only for a zero that is also FINAL, and here it says 'unknown'. Nothing else of the test changed.
test('a total refund is "nothing held" in the SNAPSHOT (proven, zero) but not for good: the refund can still fail, so "is nothing held?" does not say yes', async () => {
  const position = await compute(withRefunds([refund({ amount: 100 })], 100))
  const { retainedIsZero } = await load()
  assert.equal(position.certainty, 'proven')
  assert.equal(position.retainedCents, 0, 'the snapshot shows zero')
  assert.equal(retainedIsZero(position), 'unknown')
  assert.equal(position.final, false)
  assert.equal(position.provisionalRefundCents, 100)
})

// =====================================================================================================================================================================
// 3. A pending refund that `amount_refunded` already counts (AR-2, scenario A: 20 while pending, 20 after succeeded)
// =====================================================================================================================================================================
test('AR-2 A, while the refund is pending: it is already in amount_refunded; counted ONCE; the position is uncertain, and the worst case is the one that counts', async () => {
  const position = await compute(withRefunds([refund({ status: 'pending', amount: 20 })], 20))
  assert.equal(position.refunds.inFlightCents, 20)
  assert.equal(position.refunds.confirmedCents, 0)
  assert.equal(position.refunds.reportedByChargeCents, 20)
  bounds(position, 80, 100, 'pending')
  assert.equal(position.certainty, 'uncertain')
  assert.equal(position.retainedCents, null)
  assert.deepEqual(allCodes(position), ['uncertainty:refund_in_flight'])
  const { retainedAtLeast, retainedIsZero } = await load()
  assert.equal(retainedAtLeast(position, 80), 'yes')
  assert.equal(retainedAtLeast(position, 81), 'unknown')
  assert.equal(retainedAtLeast(position, 101), 'no')
  assert.equal(retainedIsZero(position), 'no')
  assert.equal(position.refunds.items[0].outcome, 'in_flight')
})

test('AR-2 A, after the refund succeeded: the same 20, counted once, now proven (and provisional)', async () => {
  const position = await compute(withRefunds([refund({ status: 'succeeded', amount: 20 })], 20))
  assert.equal(position.refunds.confirmedCents, 20)
  assert.equal(position.refunds.inFlightCents, 0)
  bounds(position, 80, 80, 'succeeded')
  assert.equal(position.certainty, 'proven')
  assert.equal(position.provisionalRefundCents, 20)
})

test('the aggregate and the single refunds are never added together: 20 reported + 20 listed is 20 refunded, not 40', async () => {
  for (const status of ['pending', 'succeeded']) {
    const position = await compute(withRefunds([refund({ status, amount: 20 })], 20))
    assert.equal(position.retainedLowerCents, 80, status)
  }
})

test('the project does not ASSUME that a pending refund is inside amount_refunded (it was seen so in Test Mode only): if the charge says 0, nothing is flagged, and the worst case still counts it', async () => {
  const position = await compute(withRefunds([refund({ status: 'pending', amount: 20 })], 0))
  assert.deepEqual(allCodes(position), ['uncertainty:refund_in_flight'])
  bounds(position, 80, 100)
})

const IN_FLIGHT_CASES: Array<{ name: string; status: string; note: boolean }> = [
  { name: 'pending', status: 'pending', note: false },
  { name: 'requires_action (never seen in AR-2: handled prudently, and said so)', status: 'requires_action', note: true },
]
for (const scenario of IN_FLIGHT_CASES) {
  test(`a ${scenario.name} refund is money that may leave: it counts in the worst case only, and the position is uncertain`, async () => {
    const position = await compute(withRefunds([refund({ status: scenario.status, amount: 20 })], 20))
    assert.equal(position.refunds.inFlightCents, 20)
    bounds(position, 80, 100)
    assert.equal(position.certainty, 'uncertain')
    assert.equal(Boolean(finding(position, 'state_not_observed')), scenario.note)
    assert.equal(position.final, false)
  })
}

// =====================================================================================================================================================================
// 4. A refund that SUCCEEDED and then FAILED (AR-2, scenario B): the amount goes DOWN, and nothing assumes it can only go up
// =====================================================================================================================================================================
test('AR-2 B: succeeded (20), then failed (the reversal -20 / +20 is shown): the refunded amount goes back down, the capital is whole again, proven and final', async () => {
  const before = await compute(withRefunds([refund({ amount: 20 })], 20))
  const after = await compute(withRefunds([failedRefund({ amount: 20 })], 0))
  assert.equal(before.refunds.confirmedCents, 20)
  assert.equal(before.retainedCents, 80)
  assert.equal(after.refunds.confirmedCents, 0)
  assert.equal(after.refunds.reversedCents, 20)
  assert.equal(after.refunds.items[0].outcome, 'not_effective')
  assert.equal(after.retainedCents, 100)
  assert.equal(after.certainty, 'proven')
  assert.equal(after.provisionalRefundCents, 0)
  assert.equal(after.final, true)
  assert.deepEqual(allCodes(after), [])
  // the order of the two readings changes nothing: each position is computed from the evidence it is given, with no memory of an earlier one
  const again = await compute(withRefunds([refund({ amount: 20 })], 20))
  assert.deepEqual(again, before)
})

test('a failed refund while the charge STILL reports it (a stale aggregate): refunded money that the single refunds do not explain - uncertain, worst case counts it', async () => {
  const position = await compute(withRefunds([failedRefund({ amount: 20 })], 20))
  assert.deepEqual(allCodes(position), ['uncertainty:refunded_amount_unexplained'])
  bounds(position, 80, 100)
})

test('a succeeded refund that the charge does not show yet (the charge lags): uncertain, and the optimistic bound uses the lower of the two figures', async () => {
  const position = await compute(withRefunds([refund({ amount: 20 })], 0))
  assert.deepEqual(allCodes(position), ['uncertainty:refunded_amount_lagging'])
  bounds(position, 80, 100)
})

const FAILED_REFUND_CASES: Array<{ name: string; refund: Record<string, unknown>; reported: number; codes: string[]; lower: number; upper: number; outcome: string }> = [
  { name: 'failed, with the debit and the reversal shown', refund: failedRefund(), reported: 0, codes: [], lower: 100, upper: 100, outcome: 'not_effective' },
  { name: 'failed, with the debit but NO reversal: the money may not have come back', refund: failedRefund({ failure_balance_transaction: null }), reported: 0, codes: ['uncertainty:refund_reversal_unproven'], lower: 80, upper: 100, outcome: 'unknown' },
  { name: 'failed, with no balance transaction at all (nothing shows that money left)', refund: failedRefund({ balance_transaction: null, failure_balance_transaction: null }), reported: 0, codes: [], lower: 100, upper: 100, outcome: 'not_effective' },
  { name: 'failed, with the balance transactions as ids that were not read', refund: failedRefund({ balance_transaction: 'txn_x', failure_balance_transaction: 'txn_y' }), reported: 0, codes: ['uncertainty:refund_movements_unreadable'], lower: 80, upper: 100, outcome: 'unknown' },
  { name: 'canceled, with the debit and the reversal shown (never seen in AR-2: a note says so)', refund: failedRefund({ status: 'canceled' }), reported: 0, codes: ['note:state_not_observed'], lower: 100, upper: 100, outcome: 'not_effective' },
  { name: 'canceled, with no balance transaction: not enough to say that nothing left, because the state was never seen', refund: failedRefund({ status: 'canceled', balance_transaction: null, failure_balance_transaction: null }), reported: 0, codes: ['note:state_not_observed', 'uncertainty:refund_reversal_unproven'], lower: 80, upper: 100, outcome: 'unknown' },
  { name: 'canceled, with the debit but no reversal', refund: failedRefund({ status: 'canceled', failure_balance_transaction: null }), reported: 0, codes: ['note:state_not_observed', 'uncertainty:refund_reversal_unproven'], lower: 80, upper: 100, outcome: 'unknown' },
]
for (const scenario of FAILED_REFUND_CASES) {
  test(`failed and canceled refunds - ${scenario.name}`, async () => {
    const position = await compute(withRefunds([scenario.refund], scenario.reported))
    assert.deepEqual(allCodes(position), scenario.codes)
    bounds(position, scenario.lower, scenario.upper)
    assert.equal(position.refunds.items[0].outcome, scenario.outcome)
    assert.equal(position.certainty, scenario.codes.some((code) => code.startsWith('uncertainty:')) ? 'uncertain' : 'proven')
  })
}

// =====================================================================================================================================================================
// 5. The financial reversal -20 / +20, and the fees kept apart
// =====================================================================================================================================================================
test('the refund of -20 and its failure of +20 cancel out in the capital, and fee 0 stays 0', async () => {
  const position = await compute(withRefunds([failedRefund({ amount: 20 })], 0))
  assert.equal(position.retainedCents, 100)
  assert.deepEqual(position.fees, { disputeCents: 0, refundCents: 0, totalCents: 0, complete: true })
})

test('a fee on a refund is a fee: it is reported on its own and never taken from the capital', async () => {
  const withFee = refund({ amount: 20, balance_transaction: bt({ id: 'txn_re_1', amount: -20, fee: 5, net: -25, type: 'refund', reporting_category: 'refund', source: 're_1' }) })
  const position = await compute(withRefunds([withFee], 20))
  assert.equal(position.retainedCents, 80, 'the capital moved by the refunded amount (20), not by 25')
  assert.deepEqual(position.fees, { disputeCents: 0, refundCents: 5, totalCents: 5, complete: true })
})

const REVERSAL_CASES: Array<{ name: string; refund: Record<string, unknown> }> = [
  { name: 'the failure gives back LESS than the refund took (+15 against -20)', refund: failedRefund({ failure_balance_transaction: bt({ id: 'txn_f', amount: 15, fee: 0, net: 15, type: 'refund_failure', reporting_category: 'refund_failure', source: 're_1' }) }) },
  { name: 'the failure gives back MORE than the refund took (+25 against -20)', refund: failedRefund({ failure_balance_transaction: bt({ id: 'txn_f', amount: 25, fee: 0, net: 25, type: 'refund_failure', reporting_category: 'refund_failure', source: 're_1' }) }) },
  { name: 'the reversal is NEGATIVE', refund: failedRefund({ failure_balance_transaction: bt({ id: 'txn_f', amount: -20, fee: 0, net: -20, type: 'refund_failure', reporting_category: 'refund_failure', source: 're_1' }) }) },
  { name: 'a reversal with no debit behind it', refund: failedRefund({ balance_transaction: null }) },
]
for (const scenario of REVERSAL_CASES) {
  test(`a reversal that does not match - ${scenario.name}: contradictory evidence, so nothing is concluded`, async () => {
    const position = await compute(withRefunds([scenario.refund], 0))
    assert.equal(position.certainty, 'uncertain')
    assert.ok(codesOf(position, 'conflict').includes('balance_transaction_inconsistent'), allCodes(position).join(', '))
    bounds(position, 0, 100)
    assert.equal(position.retainedCents, null)
  })
}

test('a balance transaction whose net is not amount - fee is contradictory (the net is never used, but it must not contradict)', async () => {
  const odd = refund({ balance_transaction: bt({ id: 'txn_re_1', amount: -20, fee: 0, net: -25, type: 'refund', reporting_category: 'refund', source: 're_1' }) })
  const position = await compute(withRefunds([odd], 20))
  assert.ok(codesOf(position, 'conflict').includes('balance_transaction_inconsistent'))
  bounds(position, 0, 100)
})

test('a succeeded refund whose balance transaction shows another amount is contradictory', async () => {
  const odd = refund({ amount: 20, balance_transaction: bt({ id: 'txn_re_1', amount: -15, fee: 0, net: -15, type: 'refund', reporting_category: 'refund', source: 're_1' }) })
  const position = await compute(withRefunds([odd], 20))
  assert.ok(codesOf(position, 'conflict').includes('balance_transaction_inconsistent'))
  bounds(position, 0, 100)
})

test('a succeeded refund with its balance transaction left as an id (not expanded) is fine: the refund itself is the evidence of the amount', async () => {
  const position = await compute(withRefunds([refund({ amount: 20, balance_transaction: 'txn_re_1' })], 20))
  assert.deepEqual(allCodes(position), [])
  assert.equal(position.retainedCents, 80)
})

// =====================================================================================================================================================================
// 6. Disputes: funds withdrawn, kept apart from the fee
// =====================================================================================================================================================================
test('SP1: a LOST dispute of 1.00 with a fee of 20.00: the disputed amount is gone (100), the fee is a fee (2000), the capital is not "100 - 2000"', async () => {
  const position = await compute(withDisputes([dispute({ status: 'lost', balance_transactions: [withdrawal(100, 2000)] })]))
  assert.equal(position.disputes.withdrawnCents, 100)
  assert.equal(position.disputes.reinstatedCents, 0)
  assert.equal(position.disputes.fundsGoneLowerCents, 100)
  assert.equal(position.disputes.fundsGoneUpperCents, 100)
  assert.deepEqual(position.fees, { disputeCents: 2000, refundCents: 0, totalCents: 2000, complete: true })
  assert.equal(position.retainedCents, 0)
  assert.equal(position.certainty, 'proven', allCodes(position).join(', '))
  assert.equal(position.disputes.items[0].phase, 'lost')
  assert.equal(position.final, true)
})

test('the fee is not subtracted from the capital: a dispute of 10.00 on a payment of 50.00 with a fee of 20.00 leaves 40.00, not 20.00', async () => {
  const position = await compute(withDisputes([dispute({ amount: 1000, balance_transactions: [withdrawal(1000, 2000)] })], { paymentIntent: pi({ amount: 5000, amount_received: 5000 }), charge: charge({ amount: 5000, amount_captured: 5000, disputed: true }) }))
  assert.equal(position.collectedCents, 5000)
  assert.equal(position.retainedCents, 4000)
  assert.equal(position.fees.disputeCents, 2000)
})

test('the "net" of a balance transaction is never used: -100 with a fee of 2000 has a net of -2100, and 100 is what was withdrawn', async () => {
  const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { net: -2100 })] })]))
  assert.equal(position.disputes.withdrawnCents, 100)
})

test('a dispute that is still OPEN (needs_response) with the withdrawal already shown: the funds are out now and may come back - uncertain, with both ends shown', async () => {
  const position = await compute(withDisputes([dispute({ status: 'needs_response', balance_transactions: [withdrawal(100, 2000)] })]))
  assert.equal(position.certainty, 'uncertain')
  assert.deepEqual(allCodes(position), ['uncertainty:dispute_open'])
  bounds(position, 0, 100)
  assert.equal(position.disputes.items[0].phase, 'open')
  assert.equal(position.disputes.fundsGoneLowerCents, 100)
  assert.equal(position.disputes.fundsGoneUpperCents, 0)
  assert.equal(position.final, false)
})

const OPEN_STATUSES = ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review']
for (const status of OPEN_STATUSES) {
  test(`dispute status ${status} is open: never harmless, even when no withdrawal is shown yet`, async () => {
    const position = await compute(withDisputes([dispute({ status, balance_transactions: [] })]))
    assert.ok(codesOf(position, 'uncertainty').includes('dispute_open'))
    bounds(position, 0, 100)
  })
}

// =====================================================================================================================================================================
// 7-9. A WON dispute: the word alone proves nothing; the reinstatement does. A LOST one is never harmless because it is closed.
// =====================================================================================================================================================================
const WON_CASES: Array<{ name: string; transactions: unknown[]; lower: number; upper: number; codes: string[]; certainty: 'proven' | 'uncertain'; reinstated: number }> = [
  { name: 'won, with the withdrawal AND the reinstatement shown (SP1): the funds are back, the fee of 20.00 is not', transactions: [withdrawal(100, 2000), reinstatement(100, 0)], lower: 100, upper: 100, codes: [], certainty: 'proven', reinstated: 100 },
  { name: 'won, with the withdrawal but NO reinstatement shown: the word "won" does not prove the funds are back', transactions: [withdrawal(100, 2000)], lower: 0, upper: 100, codes: ['uncertainty:dispute_won_funds_not_returned'], certainty: 'uncertain', reinstated: 0 },
  { name: 'won, with only PART of the funds reinstated (40 of 100)', transactions: [withdrawal(100, 2000), reinstatement(40, 0)], lower: 40, upper: 100, codes: ['uncertainty:dispute_won_funds_not_returned'], certainty: 'uncertain', reinstated: 40 },
  { name: 'won, with NO movement shown at all', transactions: [], lower: 0, upper: 100, codes: ['uncertainty:dispute_won_funds_not_shown'], certainty: 'uncertain', reinstated: 0 },
  { name: 'won, and the reinstatement carries its own fee (not given back is one thing, a fee on the way back is another): still just a fee', transactions: [withdrawal(100, 2000), reinstatement(100, 7)], lower: 100, upper: 100, codes: [], certainty: 'proven', reinstated: 100 },
]
for (const scenario of WON_CASES) {
  test(`dispute won - ${scenario.name}`, async () => {
    const position = await compute(withDisputes([dispute({ status: 'won', balance_transactions: scenario.transactions })]))
    assert.deepEqual(allCodes(position), scenario.codes)
    bounds(position, scenario.lower, scenario.upper)
    assert.equal(position.certainty, scenario.certainty)
    assert.equal(position.disputes.reinstatedCents, scenario.reinstated)
    assert.equal(position.disputes.items[0].phase, 'won')
  })
}

test('SP1 T9: Charge.disputed stays TRUE after a win; with the reinstatement shown the position is proven all the same - the flag decides nothing', async () => {
  const position = await compute(withDisputes([dispute({ status: 'won', balance_transactions: [withdrawal(), reinstatement()] })]))
  assert.equal(position.certainty, 'proven')
  assert.equal(position.retainedCents, 100)
  assert.equal(position.fees.disputeCents, 2000)
  assert.equal(position.fees.totalCents, 2000)
})

const LOST_CASES: Array<{ name: string; transactions: unknown[]; lower: number; upper: number; codes: string[] }> = [
  { name: 'lost, the withdrawal shown for the whole disputed amount', transactions: [withdrawal(100, 2000)], lower: 0, upper: 0, codes: [] },
  { name: 'lost, NO withdrawal shown: "closed" and "lost" do not make it harmless', transactions: [], lower: 0, upper: 100, codes: ['uncertainty:dispute_lost_without_withdrawal'] },
  { name: 'lost, only 60 of the 100 withdrawn', transactions: [withdrawal(60, 2000)], lower: 0, upper: 40, codes: ['uncertainty:dispute_withdrawal_incomplete'] },
  { name: 'lost, the movements were not read at all', transactions: null as unknown as unknown[], lower: 0, upper: 100, codes: ['uncertainty:dispute_movements_not_read'] },
  { name: 'lost, the movements are ids that were not read', transactions: ['txn_a'], lower: 0, upper: 100, codes: ['uncertainty:dispute_movements_unreadable'] },
  { name: 'lost, but MORE was withdrawn than was disputed', transactions: [withdrawal(150, 2000)], lower: 0, upper: 100, codes: ['conflict:dispute_amounts_inconsistent'] },
  { name: 'lost, and funds were ALSO reinstated: contradictory', transactions: [withdrawal(100, 2000), reinstatement(100, 0)], lower: 0, upper: 100, codes: ['conflict:dispute_amounts_inconsistent'] },
]
for (const scenario of LOST_CASES) {
  test(`dispute lost - ${scenario.name}`, async () => {
    const position = await compute(withDisputes([dispute({ status: 'lost', balance_transactions: scenario.transactions })]))
    assert.deepEqual(allCodes(position), scenario.codes)
    bounds(position, scenario.lower, scenario.upper)
    assert.equal(position.certainty, scenario.codes.length > 0 ? 'uncertain' : 'proven')
    if (scenario.codes.length > 0) assert.equal(position.retainedCents, null)
  })
}

test('a won dispute whose reinstatement is larger than the withdrawal is contradictory', async () => {
  const position = await compute(withDisputes([dispute({ status: 'won', balance_transactions: [withdrawal(100, 2000), reinstatement(150, 0)] })]))
  assert.ok(codesOf(position, 'conflict').includes('dispute_amounts_inconsistent'))
  bounds(position, 0, 100)
})

const UNMODELED_STATUSES = ['warning_closed', 'prevented', 'a_status_nobody_knows', 'WON', 'Lost', 'Needs_response']
for (const status of UNMODELED_STATUSES) {
  test(`dispute status ${status} was never seen: it is described, never trusted - uncertain, worst case counts the disputed amount as gone`, async () => {
    const position = await compute(withDisputes([dispute({ status, balance_transactions: [] })]))
    assert.deepEqual(allCodes(position), ['uncertainty:dispute_status_not_modeled'])
    bounds(position, 0, 100)
    assert.equal(position.disputes.items[0].phase, 'unmodeled')
  })
}

// =====================================================================================================================================================================
// 10. A fee larger than the original amount never touches the capital
// =====================================================================================================================================================================
const FEE_CASES: Array<{ name: string; payment: number; disputed: number; fee: number; status: 'lost' | 'won'; retained: number }> = [
  { name: 'lost: payment 1.00, fee 20.00', payment: 100, disputed: 100, fee: 2000, status: 'lost', retained: 0 },
  { name: 'won: payment 1.00, fee 20.00', payment: 100, disputed: 100, fee: 2000, status: 'won', retained: 100 },
  { name: 'lost, partial: payment 1.00, disputed 0.40, fee 20.00', payment: 100, disputed: 40, fee: 2000, status: 'lost', retained: 60 },
  { name: 'won, partial: payment 1.00, disputed 0.40, fee 999999.99', payment: 100, disputed: 40, fee: 99_999_999, status: 'won', retained: 100 },
]
for (const scenario of FEE_CASES) {
  test(`a fee higher than the payment - ${scenario.name}`, async () => {
    const transactions = scenario.status === 'won' ? [withdrawal(scenario.disputed, scenario.fee), reinstatement(scenario.disputed, 0)] : [withdrawal(scenario.disputed, scenario.fee)]
    const position = await compute(withDisputes([dispute({ status: scenario.status, amount: scenario.disputed, balance_transactions: transactions })], { paymentIntent: pi({ amount: scenario.payment, amount_received: scenario.payment }), charge: charge({ amount: scenario.payment, amount_captured: scenario.payment, disputed: true }) }))
    assert.equal(position.retainedCents, scenario.retained)
    assert.equal(position.fees.disputeCents, scenario.fee)
    assert.equal(position.certainty, 'proven', allCodes(position).join(', '))
    assert.ok(position.retainedLowerCents >= 0)
  })
}

test('the fee is not a fixed number anywhere: other fees in other places give the same capital', async () => {
  for (const fee of [0, 1, 1500, 2000, 4500, 123_456]) {
    const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, fee)] })]))
    assert.equal(position.retainedCents, 0, `fee ${fee}`)
    assert.equal(position.fees.disputeCents, fee, `fee ${fee}`)
  }
})

// =====================================================================================================================================================================
// 6b. A refund AND a lost dispute on the same charge: nothing is counted twice
// =====================================================================================================================================================================
test('a refund and a lost dispute together: the outflows add up once each; more recovered than collected is reported, never a negative capital', async () => {
  const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000)] })], { refunds: list([refund({ amount: 20 })]), charge: charge({ amount_refunded: 20, disputed: true }) }))
  assert.equal(position.retainedCents, 0)
  assert.equal(position.overRecoveredCents, 20)
  assert.deepEqual(codesOf(position, 'anomaly'), ['over_recovered'])
  const partial = await compute(withDisputes([dispute({ amount: 30, balance_transactions: [withdrawal(30, 2000)] })], { refunds: list([refund({ amount: 20 })]), charge: charge({ amount_refunded: 20, disputed: true }) }))
  assert.equal(partial.retainedCents, 50)
  assert.equal(partial.overRecoveredCents, 0)
})

// =====================================================================================================================================================================
// 11. Missing, incomplete, discordant and foreign evidence: nothing is concluded from what was not seen
// =====================================================================================================================================================================
const NOTHING_READ_CASES: Array<[string, unknown]> = [
  ['no evidence at all', undefined],
  ['null', null],
  ['an empty object', {}],
  ['a number', 42],
  ['a string', 'evidence'],
  ['an array', []],
  ['true', true],
  ['the payment is null', { paymentIntent: null, charge: charge(), refunds: list([]), disputes: list([]) }],
  ['everything but the payment (nothing can be attributed without it)', { charge: charge(), refunds: list([refund()]), disputes: list([dispute()]) }],
]
for (const [name, evidence] of NOTHING_READ_CASES) {
  test(`without the payment nothing is known and nothing is granted - ${name}`, async () => {
    const position = await compute(evidence)
    assert.deepEqual(allCodes(position), ['uncertainty:payment_intent_missing'])
    assert.equal(position.collectedCents, null)
    assert.equal(position.currency, null)
    assert.equal(position.certainty, 'uncertain')
    assert.equal(position.final, false)
    assert.equal(position.retainedCents, null)
    assert.equal(position.fees.complete, false)
    assert.equal(position.fees.totalCents, 0)
    bounds(position, 0, null)
    const { retainedAtLeast, retainedIsZero } = await load()
    assert.equal(retainedAtLeast(position, 1), 'unknown')
    assert.equal(retainedIsZero(position), 'unknown')
  })
}

const UNREAD_CASES: Array<{ name: string; over: Record<string, unknown>; codes: string[] }> = [
  { name: 'the charge was not read at all: no total refunded and no disputed flag to cross-check', over: { charge: null }, codes: ['uncertainty:dispute_state_unknown', 'uncertainty:refund_total_not_read'] },
  { name: 'the charge does not say how much was refunded', over: { charge: charge({ amount_refunded: undefined }) }, codes: ['uncertainty:refund_total_not_read'] },
  { name: 'the charge reports a null total refunded', over: { charge: charge({ amount_refunded: null }) }, codes: ['uncertainty:refund_total_not_read'] },
  { name: 'the charge does not say whether it is disputed', over: { charge: charge({ disputed: undefined }) }, codes: ['uncertainty:dispute_state_unknown'] },
  { name: 'the disputed flag is not a boolean ("false" as text)', over: { charge: charge({ disputed: 'false' }) }, codes: ['uncertainty:dispute_state_unknown'] },
  { name: 'the refunds were not read (null)', over: { refunds: null }, codes: ['uncertainty:refunds_not_read'] },
  { name: 'the refunds are missing', over: { refunds: undefined }, codes: ['uncertainty:refunds_not_read'] },
  { name: 'the refunds are not a list', over: { refunds: 'none' }, codes: ['uncertainty:refunds_not_read'] },
  { name: 'the refunds list has no data', over: { refunds: { has_more: false } }, codes: ['uncertainty:refunds_not_read'] },
  { name: 'the refunds list data is not an array', over: { refunds: { data: {}, has_more: false } }, codes: ['uncertainty:refunds_not_read'] },
  { name: 'the refunds list says there are more', over: { refunds: list([], true) }, codes: ['uncertainty:refunds_incomplete'] },
  { name: 'the refunds list does not say whether there are more', over: { refunds: list([], 'omit') }, codes: ['uncertainty:refunds_incomplete'] },
  { name: 'the disputes were not read (null)', over: { disputes: null }, codes: ['uncertainty:disputes_not_read'] },
  { name: 'the disputes are missing', over: { disputes: undefined }, codes: ['uncertainty:disputes_not_read'] },
  { name: 'the disputes are not a list', over: { disputes: 7 }, codes: ['uncertainty:disputes_not_read'] },
  { name: 'the disputes list has no data', over: { disputes: { has_more: false } }, codes: ['uncertainty:disputes_not_read'] },
  { name: 'the disputes list says there are more', over: { disputes: list([], true) }, codes: ['uncertainty:disputes_incomplete'] },
  { name: 'the disputes list does not say whether there are more', over: { disputes: list([], 'omit') }, codes: ['uncertainty:disputes_incomplete'] },
]
for (const scenario of UNREAD_CASES) {
  test(`what was not read is not "nothing there" - ${scenario.name}`, async () => {
    const position = await compute(ev(scenario.over))
    assert.deepEqual(allCodes(position), scenario.codes)
    assert.equal(position.certainty, 'uncertain')
    assert.equal(position.final, false)
    assert.equal(position.retainedCents, null)
    bounds(position, 0, 100)
    const { retainedAtLeast, retainedIsZero } = await load()
    assert.equal(retainedAtLeast(position, 1), 'unknown')
    assert.equal(retainedIsZero(position), 'unknown')
  })
}

test('an incomplete refunds list still counts what it shows: the worst case is that everything left, the best case is what is proven', async () => {
  const position = await compute(ev({ refunds: list([refund({ amount: 20 })], true), charge: charge({ amount_refunded: 20 }) }))
  assert.deepEqual(allCodes(position), ['uncertainty:refunds_incomplete'])
  bounds(position, 0, 80)
  assert.equal(position.refunds.confirmedCents, 20)
})

test('an incomplete disputes list still counts the dispute it shows; zero is not CLAIMED from an uncertain position, though "less than 1" is certain', async () => {
  const position = await compute(ev({ disputes: list([dispute()], true), charge: charge({ disputed: true }) }))
  assert.deepEqual(allCodes(position), ['uncertainty:disputes_incomplete'])
  bounds(position, 0, 0)
  const { retainedAtLeast, retainedIsZero } = await load()
  assert.equal(retainedAtLeast(position, 1), 'no')
  assert.equal(retainedIsZero(position), 'unknown', 'a "yes, nothing is held" is given only to a proven position')
})

// ---- evidence that belongs to another payment, or to nothing we can name ----------------------------------------------------------------------------------------------
const FOREIGN_CASES: Array<{ name: string; evidence: () => unknown; codes: string[] }> = [
  { name: 'a refund of another PaymentIntent', evidence: () => withRefunds([refund({ payment_intent: 'pi_other' })], 0), codes: ['conflict:foreign_evidence'] },
  { name: 'a refund of another charge', evidence: () => withRefunds([refund({ payment_intent: null, charge: 'ch_other' })], 0), codes: ['conflict:foreign_evidence'] },
  { name: 'a refund that is right about the payment and wrong about the charge', evidence: () => withRefunds([refund({ charge: 'ch_other' })], 0), codes: ['conflict:foreign_evidence'] },
  { name: 'a refund that names neither a payment nor a charge: it can not be attributed', evidence: () => withRefunds([refund({ payment_intent: null, charge: null })], 0), codes: ['conflict:unattributable_evidence'] },
  { name: 'a dispute of another PaymentIntent (the charge says it is disputed: no usable dispute is left)', evidence: () => withDisputes([dispute({ payment_intent: 'pi_other' })]), codes: ['conflict:foreign_evidence', 'uncertainty:disputed_charge_without_dispute'] },
  { name: 'a dispute of another charge', evidence: () => withDisputes([dispute({ payment_intent: null, charge: 'ch_other' })]), codes: ['conflict:foreign_evidence', 'uncertainty:disputed_charge_without_dispute'] },
  { name: 'a dispute that names neither a payment nor a charge', evidence: () => withDisputes([dispute({ payment_intent: null, charge: null })]), codes: ['conflict:unattributable_evidence', 'uncertainty:disputed_charge_without_dispute'] },
  { name: 'a withdrawal that belongs to another dispute', evidence: () => withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { source: 'dp_other' })] })]), codes: ['conflict:foreign_evidence'] },
  { name: 'a refund movement that belongs to another refund', evidence: () => withRefunds([refund({ balance_transaction: bt({ id: 'txn_x', amount: -20, fee: 0, net: -20, type: 'refund', reporting_category: 'refund', source: 're_other' }) })], 0), codes: ['conflict:foreign_evidence'] },
  { name: 'a failure movement that belongs to another refund', evidence: () => withRefunds([failedRefund({ failure_balance_transaction: bt({ id: 'txn_x', amount: 20, fee: 0, net: 20, type: 'refund_failure', reporting_category: 'refund_failure', source: 're_other' }) })], 0), codes: ['conflict:foreign_evidence'] },
]
for (const scenario of FOREIGN_CASES) {
  test(`evidence that is not provably this payment's is never counted as its money - ${scenario.name}`, async () => {
    const position = await compute(scenario.evidence())
    assert.deepEqual(allCodes(position), scenario.codes)
    assert.equal(position.certainty, 'uncertain')
    assert.equal(position.retainedCents, null)
    assert.equal(position.final, false)
    bounds(position, 0, 100)
    assert.equal(position.refunds.confirmedCents + position.refunds.inFlightCents, 0, 'nothing of it is added to the refunds')
    assert.equal(position.disputes.withdrawnCents, 0, 'nothing of it is added to the withdrawals')
    const { retainedAtLeast, retainedIsZero } = await load()
    assert.equal(retainedAtLeast(position, 1), 'unknown')
    assert.equal(retainedIsZero(position), 'unknown')
  })
}

test('a foreign refund is listed as excluded, and the aggregate of the charge then has nothing to be explained by', async () => {
  const position = await compute(withRefunds([refund({ payment_intent: 'pi_other', amount: 100 })], 100))
  assert.equal(position.refunds.items[0].outcome, 'excluded')
  assert.deepEqual(allCodes(position), ['conflict:foreign_evidence', 'uncertainty:refunded_amount_unexplained'])
  bounds(position, 0, 100)
})

test('a foreign dispute is listed as excluded', async () => {
  const position = await compute(withDisputes([dispute({ payment_intent: 'pi_other' })]))
  assert.equal(position.disputes.items[0].phase, 'excluded')
})

test('a refund that names only the right charge, or only the right payment, is attributable', async () => {
  for (const over of [{ payment_intent: null }, { charge: null }]) {
    const position = await compute(withRefunds([refund(over)], 20))
    assert.deepEqual(allCodes(position), [], JSON.stringify(over))
    assert.equal(position.retainedCents, 80)
  }
})

test('expanded objects are read like ids (the charge in latest_charge, the payment in the charge, the source of a movement)', async () => {
  const position = await compute(withDisputes(
    [dispute({ payment_intent: { id: PI }, charge: { id: CH }, balance_transactions: [withdrawal(100, 2000, { source: { id: 'dp_1' } })] })],
    { paymentIntent: pi({ latest_charge: { id: CH } }), charge: charge({ disputed: true, payment_intent: { id: PI } }) },
  ))
  assert.deepEqual(allCodes(position), [])
  assert.equal(position.retainedCents, 0)
})

// ---- the charge and the payment must be the same money ------------------------------------------------------------------------------------------------------------
const CHARGE_MISMATCH_CASES: Array<[string, Record<string, unknown>]> = [
  ['the charge names another payment', { charge: charge({ payment_intent: 'pi_other' }) }],
  ['the charge names no payment', { charge: charge({ payment_intent: null }) }],
  ['the charge is not the latest charge of the payment', { charge: charge({ id: 'ch_other' }) }],
  ['the charge captured another amount than the payment received', { charge: charge({ amount_captured: 90 }) }],
]
for (const [name, over] of CHARGE_MISMATCH_CASES) {
  test(`charge and payment must agree - ${name}`, async () => {
    const position = await compute(ev(over))
    assert.deepEqual(allCodes(position), ['conflict:charge_mismatch'])
    bounds(position, 0, 100)
    assert.equal(position.retainedCents, null)
  })
}

// ---- currencies -----------------------------------------------------------------------------------------------------------------------------------------------------------------
const CURRENCY_MISMATCH_CASES: Array<[string, () => unknown, 'refund' | 'dispute' | null]> = [
  ['a refund', () => withRefunds([refund({ currency: 'usd' })], 20), 'refund'],
  ['the movement of a refund', () => withRefunds([refund({ balance_transaction: bt({ id: 'txn_x', amount: -20, fee: 0, net: -20, currency: 'usd', type: 'refund', reporting_category: 'refund', source: 're_1' }) })], 20), 'refund'],
  ['a dispute', () => withDisputes([dispute({ currency: 'usd' })]), 'dispute'],
  ['the movement of a dispute', () => withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { currency: 'usd' })] })]), 'dispute'],
  ['the charge', () => ev({ charge: charge({ currency: 'usd' }) }), null],
]
for (const [name, build, setAside] of CURRENCY_MISMATCH_CASES) {
  test(`a currency that is not the payment's is a contradiction, not a conversion - ${name}`, async () => {
    const position = await compute(build())
    assert.ok(codesOf(position, 'conflict').includes('currency_mismatch'), allCodes(position).join(', '))
    if (setAside === 'refund') assert.equal(position.refunds.items[0].outcome, 'excluded', 'what is in another currency is set aside, not counted as if it were euro')
    if (setAside === 'dispute') assert.equal(position.disputes.items[0].phase, 'excluded')
    assert.equal(position.currency, 'eur')
    assert.equal(position.retainedCents, null)
    bounds(position, 0, 100)
  })
}

// ---- refunds that were REQUESTED (an intention, not yet a Stripe object) ------------------------------------------------------------------------------------------
test('a refund that was REQUESTED and is not (yet) among the refunds Stripe lists: counted in the worst case only, and the position is uncertain', async () => {
  const position = await compute(ev({ requestedRefunds: [{ amount: 20 }] }))
  assert.deepEqual(allCodes(position), ['uncertainty:refund_requested'])
  assert.equal(position.refunds.requestedCents, 20)
  bounds(position, 80, 100)
  assert.equal(position.final, false)
  const { retainedAtLeast, retainedIsZero } = await load()
  assert.equal(retainedAtLeast(position, 80), 'yes')
  assert.equal(retainedAtLeast(position, 100), 'unknown')
  assert.equal(retainedIsZero(position), 'no')
})

test('a requested refund that Stripe now lists as PENDING is the same refund: counted once', async () => {
  const position = await compute(withRefunds([refund({ status: 'pending', amount: 20 })], 20, { requestedRefunds: [{ id: 're_1', amount: 20 }] }))
  assert.deepEqual(allCodes(position), ['uncertainty:refund_in_flight'])
  assert.equal(position.refunds.requestedCents, 0)
  bounds(position, 80, 100)
})

test('a requested refund that Stripe now lists as SUCCEEDED is the same refund: counted once, and the position is proven', async () => {
  const position = await compute(withRefunds([refund({ amount: 20 })], 20, { requestedRefunds: [{ id: 're_1', amount: 20 }] }))
  assert.deepEqual(allCodes(position), [])
  assert.equal(position.refunds.requestedCents, 0)
  bounds(position, 80, 80)
})

test('a requested refund the charge already reports (the list has not caught up): the aggregate is not an addend, and it is explained by the request', async () => {
  const position = await compute(ev({ requestedRefunds: [{ amount: 20 }], charge: charge({ amount_refunded: 20 }) }))
  assert.deepEqual(allCodes(position), ['uncertainty:refund_requested'])
  bounds(position, 80, 100)
})

test('two requests without an id are two requests (nothing says they are the same refund); two requests with the same id are one', async () => {
  const two = await compute(ev({ requestedRefunds: [{ amount: 20 }, { amount: 20 }] }))
  assert.equal(two.refunds.requestedCents, 40)
  bounds(two, 60, 100)
  const same = await compute(ev({ requestedRefunds: [{ id: 're_7', amount: 20 }, { id: 're_7', amount: 20 }] }))
  assert.equal(same.refunds.requestedCents, 20)
  assert.deepEqual(allCodes(same), ['note:duplicate_removed', 'uncertainty:refund_requested'])
})

test('no request at all, or an empty list of requests, says nothing', async () => {
  for (const requestedRefunds of [undefined, null, []]) {
    const position = await compute(ev({ requestedRefunds }))
    assert.deepEqual(allCodes(position), [])
    assert.equal(position.refunds.requestedCents, 0)
  }
})

const BAD_REQUEST_CASES: Array<[string, unknown, string]> = [
  ['an amount of zero', [{ amount: 0 }], 'conflict:invalid_amount'],
  ['a negative amount', [{ amount: -20 }], 'conflict:invalid_amount'],
  ['an amount with decimals', [{ amount: 20.5 }], 'conflict:invalid_amount'],
  ['no amount', [{ id: 're_9' }], 'conflict:invalid_amount'],
  ['an id with spaces', [{ id: 're 9', amount: 20 }], 'conflict:invalid_identifier'],
  ['another currency', [{ amount: 20, currency: 'usd' }], 'conflict:currency_mismatch'],
  ['an entry that is not an object', [20], 'conflict:invalid_evidence'],
  ['a list that is not a list', 'twenty', 'conflict:invalid_evidence'],
]
for (const [name, requestedRefunds, code] of BAD_REQUEST_CASES) {
  test(`a bad request is a contradiction - ${name}`, async () => {
    const position = await compute(ev({ requestedRefunds }))
    assert.ok(allCodes(position).includes(code), allCodes(position).join(', '))
    assert.equal(position.certainty, 'uncertain')
    assert.equal(position.refunds.requestedCents, 0, 'a request that is not valid is not counted')
    bounds(position, 0, 100)
  })
}

// ---- the flag of the charge is a cross-check, not the evidence ----------------------------------------------------------------------------------------------------
test('the charge says it is disputed and no dispute is listed: the funds may be gone, and nothing says how much', async () => {
  const position = await compute(ev({ charge: charge({ disputed: true }) }))
  assert.deepEqual(allCodes(position), ['uncertainty:disputed_charge_without_dispute'])
  bounds(position, 0, 100)
})

test('the charge says it is NOT disputed and a dispute is listed: contradictory', async () => {
  const position = await compute(ev({ disputes: list([dispute()]), charge: charge({ disputed: false }) }))
  assert.deepEqual(allCodes(position), ['conflict:dispute_flag_mismatch'])
  bounds(position, 0, 100)
})

// =====================================================================================================================================================================
// 12. Duplicates and the risk of counting twice
// =====================================================================================================================================================================
test('the same refund listed twice (identical) is ONE refund', async () => {
  const position = await compute(withRefunds([refund({ amount: 20 }), refund({ amount: 20 })], 20))
  assert.equal(position.refunds.items.length, 1)
  assert.equal(position.refunds.confirmedCents, 20)
  assert.equal(position.retainedCents, 80)
  assert.deepEqual(allCodes(position), ['note:duplicate_removed'])
  assert.equal(position.certainty, 'proven', 'a duplicate that is identical is harmless')
})

test('two DIFFERENT refunds of the same amount are two refunds: nothing is merged by looking alike', async () => {
  const position = await compute(withRefunds([refund({ id: 're_a', amount: 20 }), refund({ id: 're_b', amount: 20 })], 40))
  assert.equal(position.refunds.items.length, 2)
  assert.equal(position.refunds.confirmedCents, 40)
  assert.equal(position.retainedCents, 60)
  assert.deepEqual(allCodes(position), [])
})

const CONFLICTING_REFUND_CASES: Array<[string, Record<string, unknown>]> = [
  ['another amount', { amount: 30 }],
  ['another status', { status: 'failed' }],
  ['another payment', { payment_intent: 'pi_other' }],
  ['another currency', { currency: 'usd' }],
]
for (const [name, over] of CONFLICTING_REFUND_CASES) {
  test(`the same refund id described twice with ${name} is a contradiction: nothing is concluded`, async () => {
    const position = await compute(withRefunds([refund({ amount: 20 }), refund({ amount: 20, ...over })], 20))
    assert.ok(codesOf(position, 'conflict').includes('conflicting_duplicate'), allCodes(position).join(', '))
    assert.equal(position.retainedCents, null)
    bounds(position, 0, 100)
  })
}

test('the same dispute listed twice (identical) is ONE dispute: the fee and the withdrawal are not doubled', async () => {
  const position = await compute(withDisputes([dispute(), dispute()]))
  assert.equal(position.disputes.items.length, 1)
  assert.equal(position.disputes.withdrawnCents, 100)
  assert.equal(position.fees.disputeCents, 2000)
  assert.equal(position.retainedCents, 0)
  assert.deepEqual(allCodes(position), ['note:duplicate_removed'])
})

test('the same dispute id described twice with another status is a contradiction', async () => {
  const position = await compute(withDisputes([dispute({ status: 'lost' }), dispute({ status: 'won' })]))
  assert.ok(codesOf(position, 'conflict').includes('conflicting_duplicate'))
  bounds(position, 0, 100)
})

test('the same movement listed twice (same id, identical) is ONE movement: the withdrawal and its fee are not doubled', async () => {
  const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000), withdrawal(100, 2000)] })]))
  assert.equal(position.disputes.withdrawnCents, 100)
  assert.equal(position.fees.disputeCents, 2000)
  assert.deepEqual(allCodes(position), ['note:duplicate_removed'])
  assert.equal(position.retainedCents, 0)
})

test('a second movement with ANOTHER id is another movement, even if it looks the same - and here it is more than the dispute, so it is a contradiction', async () => {
  const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000), withdrawal(100, 2000, { id: 'txn_dp_w2' })] })]))
  assert.deepEqual(allCodes(position), ['conflict:dispute_amounts_inconsistent'])
  bounds(position, 0, 100)
})

test('the same movement id with another content is a contradiction, and the dispute is set aside', async () => {
  const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000), withdrawal(60, 2000)] })]))
  assert.ok(codesOf(position, 'conflict').includes('conflicting_duplicate'))
  assert.equal(position.disputes.items[0].phase, 'excluded')
  bounds(position, 0, 100)
})

test('one movement id used by two owners (a refund and a dispute) is a contradiction', async () => {
  const shared = bt({ id: 'txn_dp_w', amount: -20, fee: 0, net: -20, type: 'refund', reporting_category: 'refund', source: 're_1' })
  const position = await compute(withDisputes([dispute()], { refunds: list([refund({ balance_transaction: shared })]), charge: charge({ disputed: true, amount_refunded: 20 }) }))
  assert.ok(codesOf(position, 'conflict').includes('conflicting_duplicate'), allCodes(position).join(', '))
  bounds(position, 0, 100)
})

test('the aggregate is a signal, never an addend: 20 listed and 50 reported is 50 at most, not 70', async () => {
  const position = await compute(withRefunds([refund({ amount: 20 })], 50))
  assert.deepEqual(allCodes(position), ['uncertainty:refunded_amount_unexplained'])
  bounds(position, 50, 80)
})

test('a refund seen as a listed refund, as its own balance movement and in the aggregate is ONE refund of 20, not three', async () => {
  const position = await compute(withRefunds([refund({ amount: 20 })], 20))
  assert.equal(position.refunds.confirmedCents, 20)
  assert.equal(position.retainedCents, 80)
  assert.equal(position.provisionalRefundCents, 20)
})

// =====================================================================================================================================================================
// 13. States and movements nobody has modeled
// =====================================================================================================================================================================
const UNKNOWN_REFUND_STATUSES: Array<[string, unknown]> = [
  ['a status nobody knows', 'brand_new'],
  ['no status', undefined],
  ['a null status', null],
  ['an empty status', ''],
  ['a status in capital letters (nothing is guessed)', 'SUCCEEDED'],
  ['a number', 7],
]
for (const [name, status] of UNKNOWN_REFUND_STATUSES) {
  test(`a refund in ${name} may be money that leaves: worst case counts it, nothing is granted`, async () => {
    const position = await compute(withRefunds([refund({ amount: 20, status })], 20))
    assert.deepEqual(allCodes(position), ['uncertainty:refund_state_unknown'])
    assert.equal(position.refunds.unknownCents, 20)
    assert.equal(position.refunds.confirmedCents, 0)
    assert.equal(position.refunds.items[0].outcome, 'unknown')
    bounds(position, 80, 100)
    const { retainedAtLeast, retainedIsZero } = await load()
    assert.notEqual(retainedAtLeast(position, 100), 'yes')
    assert.notEqual(retainedIsZero(position), 'yes')
  })
}

const UNRECOGNIZED_MOVEMENTS: Array<[string, Record<string, unknown>]> = [
  ['a category nobody knows', withdrawal(100, 2000, { reporting_category: 'other_adjustment' })],
  ['no category at all', withdrawal(100, 2000, { reporting_category: undefined })],
  ['a fee category', withdrawal(100, 2000, { reporting_category: 'fee' })],
  ['a withdrawal with a POSITIVE amount', bt({ id: 'txn_dp_w', amount: 100, fee: 2000, net: -1900, reporting_category: 'dispute' })],
  ['a reinstatement with a NEGATIVE amount', bt({ id: 'txn_dp_r', amount: -100, fee: 0, net: -100, reporting_category: 'dispute_reversal' })],
]
for (const [name, movement] of UNRECOGNIZED_MOVEMENTS) {
  test(`a movement of a dispute that is not recognized is a contradiction, never a guess - ${name}`, async () => {
    const position = await compute(withDisputes([dispute({ status: 'won', balance_transactions: [movement, ...(movement.reporting_category === 'dispute_reversal' ? [withdrawal(100, 2000)] : [])] })]))
    assert.ok(codesOf(position, 'conflict').includes('unrecognized_movement'), allCodes(position).join(', '))
    assert.equal(position.disputes.items[0].phase, 'excluded', 'a dispute with a movement nobody can read is set aside, not half counted')
    assert.equal(position.retainedCents, null)
    bounds(position, 0, 100)
  })
}

test('a fee posted on its own movement (amount 0) is a fee: it moves no capital', async () => {
  const feeOnly = withdrawal(0, 1500, { id: 'txn_dp_fee', amount: 0, net: -1500 })
  const position = await compute(withDisputes([dispute({ balance_transactions: [feeOnly, withdrawal(100, 0)] })]))
  assert.deepEqual(allCodes(position), [])
  assert.equal(position.disputes.withdrawnCents, 100)
  assert.equal(position.fees.disputeCents, 1500)
  assert.equal(position.retainedCents, 0)
})

test('a refund with a failure movement although it SUCCEEDED is a contradiction', async () => {
  const odd = refund({ amount: 20, failure_balance_transaction: bt({ id: 'txn_f', amount: 20, fee: 0, net: 20, type: 'refund_failure', reporting_category: 'refund_failure', source: 're_1' }) })
  const position = await compute(withRefunds([odd], 20))
  assert.ok(codesOf(position, 'conflict').includes('balance_transaction_inconsistent'))
  bounds(position, 0, 100)
})

test('no unknown state, anywhere, ever grants anything: the position never claims more than the proven part', async () => {
  const { retainedAtLeast, retainedIsZero } = await load()
  const evidences = [
    withRefunds([refund({ status: 'zzz' })], 20),
    withRefunds([refund({ status: 'requires_action' })], 20),
    withRefunds([refund({ status: 'pending' })], 20),
    withDisputes([dispute({ status: 'zzz', balance_transactions: [] })]),
    withDisputes([dispute({ status: 'prevented', balance_transactions: [] })]),
    ev({ paymentIntent: pi({ status: 'zzz', amount_received: 0 }), charge: charge({ amount_captured: 0 }) }),
  ]
  for (const evidence of evidences) {
    const position = await compute(evidence)
    assert.equal(position.certainty, 'uncertain')
    assert.equal(position.retainedCents, null)
    assert.equal(position.final, false)
    assert.notEqual(retainedIsZero(position), 'yes')
    assert.notEqual(retainedAtLeast(position, 100), 'yes')
  }
})

// =====================================================================================================================================================================
// 14. Amounts, signs, currencies, identifiers and shapes that are not what they must be
// =====================================================================================================================================================================
// every number of a position, wherever it is
function numbersIn(value: unknown, into: number[] = []): number[] {
  if (typeof value === 'number') into.push(value)
  else if (Array.isArray(value)) for (const item of value) numbersIn(item, into)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) numbersIn(item, into)
  return into
}
// what must hold for the position of ANY evidence, however wrong
async function assertWellFormed(position: FundsPosition, label = '') {
  const { FUNDS_FINDING_CODES } = await load()
  const registry = FUNDS_FINDING_CODES as Record<string, string>
  for (const number of numbersIn(position)) assert.ok(Number.isSafeInteger(number) && !Object.is(number, -0), `${label} a number of the position is not a whole number of cents: ${String(number)}`)
  assert.ok(position.retainedLowerCents >= 0, `${label} lower bound`)
  if (position.retainedUpperCents !== null) assert.ok(position.retainedLowerCents <= position.retainedUpperCents, `${label} lower <= upper`)
  if (position.collectedCents !== null && position.retainedUpperCents !== null) assert.ok(position.retainedUpperCents <= position.collectedCents, `${label} upper <= collected`)
  if (position.retainedCents !== null) {
    assert.equal(position.certainty, 'proven', `${label} a single figure only for a proven position`)
    assert.equal(position.retainedLowerCents, position.retainedUpperCents, `${label} a single figure only when the bounds meet`)
    assert.equal(position.retainedCents, position.retainedLowerCents, `${label} the figure is the bound`)
  }
  assert.equal(position.certainty === 'proven', !position.findings.some((entry) => entry.kind === 'uncertainty' || entry.kind === 'conflict'), `${label} certainty is "no uncertainty and no conflict"`)
  if (position.final) {
    assert.equal(position.certainty, 'proven', `${label} final needs proof`)
    assert.equal(position.provisionalRefundCents, 0, `${label} final needs no provisional refund`)
  }
  for (const entry of position.findings) {
    assert.equal(registry[entry.code], entry.kind, `${label} finding ${entry.code} is not registered as ${entry.kind}`)
    assert.ok(typeof entry.detail === 'string' && entry.detail.length > 0, `${label} finding ${entry.code} has no text`)
    assert.ok(entry.ref === null || /^[A-Za-z0-9_]{1,255}$/.test(entry.ref), `${label} finding ${entry.code} carries a reference that is not an identifier`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(position)), position, `${label} the position is plain data (no undefined, no class, no cycle)`)

  // the objects are listed in order of their id, each once
  const ascending = (ids: string[]) => ids.every((id, index) => index === 0 || ids[index - 1] < id)
  const refunds = position.refunds.items
  const disputes = position.disputes.items
  assert.ok(ascending(refunds.map((item) => item.id)), `${label} refunds in order of id, each once`)
  assert.ok(ascending(disputes.map((item) => item.id)), `${label} disputes in order of id, each once`)
  // nothing is set aside without a word
  if (refunds.some((item) => item.outcome === 'excluded') || disputes.some((item) => item.phase === 'excluded')) {
    assert.ok(position.findings.some((entry) => entry.kind === 'conflict'), `${label} something was set aside and nothing says why`)
  }
  // the summary and the items say the same thing (unless a sum overflowed: then the sum stops at the largest safe integer)
  if (!position.findings.some((entry) => entry.code === 'invalid_amount')) {
    const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0)
    const ofOutcome = (outcome: string) => total(refunds.filter((item) => item.outcome === outcome).map((item) => item.amountCents))
    assert.equal(position.refunds.confirmedCents, ofOutcome('effective'), `${label} confirmed refunds`)
    assert.equal(position.refunds.inFlightCents, ofOutcome('in_flight'), `${label} refunds in flight`)
    assert.equal(position.refunds.unknownCents, ofOutcome('unknown'), `${label} refunds in an unknown state`)
    assert.equal(position.disputes.withdrawnCents, total(disputes.map((item) => item.withdrawnCents)), `${label} withdrawn`)
    assert.equal(position.disputes.reinstatedCents, total(disputes.map((item) => item.reinstatedCents)), `${label} reinstated`)
    assert.equal(position.fees.refundCents, total(refunds.map((item) => item.feeCents)), `${label} refund fees`)
    assert.equal(position.fees.disputeCents, total(disputes.map((item) => item.feeCents)), `${label} dispute fees`)
    assert.equal(position.fees.totalCents, position.fees.refundCents + position.fees.disputeCents, `${label} total of the fees`)
  }
  assert.equal(position.provisionalRefundCents, position.refunds.confirmedCents, `${label} provisional = confirmed`)
  assert.ok(position.disputes.fundsGoneLowerCents >= position.disputes.fundsGoneUpperCents, `${label} the worst reading takes at least what the best one takes`)
  // a proven position has one figure (its bounds meet)
  if (position.certainty === 'proven') assert.equal(position.retainedLowerCents, position.retainedUpperCents, `${label} proven means the bounds meet`)
  // evidence that contradicts itself leaves the widest interval: nothing held for sure, everything collected possibly held (and no limit if money may still arrive)
  if (position.findings.some((entry) => entry.kind === 'conflict')) {
    assert.equal(position.retainedLowerCents, 0, `${label} conflict: lower bound`)
    assert.equal(position.retainedUpperCents, position.collectedCents === null || position.findings.some((entry) => entry.code === 'payment_open') ? null : position.collectedCents, `${label} conflict: upper bound`)
  }
  // the two questions agree with the bounds
  const { retainedAtLeast, retainedIsZero } = await load()
  assert.equal(retainedAtLeast(position, position.retainedLowerCents), 'yes', `${label} at least the lower bound`)
  if (position.retainedUpperCents !== null && Number.isSafeInteger(position.retainedUpperCents + 1)) assert.equal(retainedAtLeast(position, position.retainedUpperCents + 1), 'no', `${label} more than the upper bound`)
  if (position.certainty !== 'proven') assert.notEqual(retainedIsZero(position), 'yes', `${label} zero is never claimed from an uncertain position`)
  if (position.retainedLowerCents > 0) assert.equal(retainedIsZero(position), 'no', `${label} something is held for sure`)
  // P1-bis (B): a zero is claimed only if it is FINAL. A proven zero that rests on a refund that can still fail is zero in the snapshot, and nothing more: 'unknown'
  if (retainedIsZero(position) === 'yes') {
    assert.equal(position.certainty, 'proven', `${label} zero is claimed from a position that is not proven`)
    assert.equal(position.final, true, `${label} zero is claimed from a position that is not final`)
    assert.equal(position.retainedUpperCents, 0, `${label} zero is claimed from a position whose best reading is not zero`)
  }
  if (position.certainty === 'proven' && position.retainedUpperCents === 0) assert.equal(retainedIsZero(position), position.final ? 'yes' : 'unknown', `${label} a proven zero is "yes" when final, "unknown" when not`)
  // P1-bis (A): money that is counted only because it was requested is never counted in silence
  if (position.refunds.requestedCents > 0) assert.ok(position.findings.some((entry) => entry.code === 'refund_requested'), `${label} a request is counted and nothing says so`)
}

const NOT_CENTS: Array<[string, unknown]> = [
  ['a fraction', 0.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['a number written as text', '100'],
  ['a number beyond the safe integers', Number.MAX_SAFE_INTEGER + 1],
  ['an object', { cents: 100 }],
  ['a boolean', true],
]

const BAD_RECEIVED: Array<[string, unknown]> = [...NOT_CENTS, ['a negative number', -1], ['null', null], ['missing', undefined]]
for (const [name, value] of BAD_RECEIVED) {
  test(`amount received - ${name}: the capital is not known, so nothing is concluded`, async () => {
    const position = await compute(ev({ paymentIntent: pi({ amount_received: value }) }))
    assert.deepEqual(allCodes(position), ['conflict:invalid_amount'])
    assert.equal(position.collectedCents, null)
    assert.equal(position.currency, 'eur')
    assert.equal(position.retainedCents, null)
    bounds(position, 0, null)
    await assertWellFormed(position, name)
  })
}

const BAD_REPORTED: Array<[string, unknown]> = [...NOT_CENTS, ['a negative number', -1]]
for (const [name, value] of BAD_REPORTED) {
  test(`total refunded of the charge - ${name}: it is contradictory, not "nothing refunded"`, async () => {
    const position = await compute(ev({ charge: charge({ amount_refunded: value }) }))
    assert.deepEqual(allCodes(position), ['conflict:invalid_amount'])
    bounds(position, 0, 100)
    await assertWellFormed(position, name)
  })
}

const BAD_POSITIVE: Array<[string, unknown]> = [...NOT_CENTS, ['a negative number', -20], ['zero', 0], ['null', null], ['missing', undefined]]
for (const [name, value] of BAD_POSITIVE) {
  test(`amount of a refund - ${name}: the refund is set aside and nothing is concluded`, async () => {
    const position = await compute(withRefunds([refund({ amount: value })], 0))
    assert.deepEqual(allCodes(position), ['conflict:invalid_amount'])
    assert.equal(position.refunds.items[0].outcome, 'excluded')
    bounds(position, 0, 100)
    await assertWellFormed(position, name)
  })
  test(`amount of a dispute - ${name}: the dispute is set aside and nothing is concluded`, async () => {
    const position = await compute(withDisputes([dispute({ amount: value })]))
    assert.deepEqual(allCodes(position), ['conflict:invalid_amount'])
    assert.equal(position.disputes.items[0].phase, 'excluded')
    bounds(position, 0, 100)
    await assertWellFormed(position, name)
  })
}

const BAD_MOVEMENT_AMOUNT: Array<[string, unknown]> = [...NOT_CENTS, ['null', null], ['missing', undefined]]
for (const [name, value] of BAD_MOVEMENT_AMOUNT) {
  test(`amount of a balance transaction - ${name}`, async () => {
    const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { amount: value })] })]))
    assert.deepEqual(allCodes(position), ['conflict:invalid_amount'])
    bounds(position, 0, 100)
    await assertWellFormed(position, name)
  })
}

const BAD_FEE: Array<[string, unknown]> = [...NOT_CENTS, ['a negative fee', -5]]
for (const [name, value] of BAD_FEE) {
  test(`fee of a balance transaction - ${name}: a fee that is not a whole non-negative number is contradictory; it never reaches the capital`, async () => {
    const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { fee: value })] })]))
    assert.deepEqual(allCodes(position), ['conflict:invalid_amount'])
    bounds(position, 0, 100)
    await assertWellFormed(position, name)
  })
}

for (const [name, value] of [['a fraction', 0.5], ['text', '-2100'], ['NaN', Number.NaN], ['an object', {}]] as Array<[string, unknown]>) {
  test(`net of a balance transaction - ${name}`, async () => {
    const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { net: value })] })]))
    assert.deepEqual(allCodes(position), ['conflict:invalid_amount'])
    bounds(position, 0, 100)
  })
}

test('a net that is a whole number but is not amount - fee is contradictory, on a dispute movement as on a refund movement', async () => {
  const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { net: -100 })] })]))
  assert.deepEqual(allCodes(position), ['conflict:balance_transaction_inconsistent'])
  bounds(position, 0, 100)
})

test('a fee that is not shown is an unknown fee, not a conflict: the capital does not depend on it, and the fees are said to be incomplete', async () => {
  const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { fee: undefined, net: undefined })] })]))
  assert.deepEqual(allCodes(position), [])
  assert.equal(position.retainedCents, 0)
  assert.deepEqual(position.fees, { disputeCents: 0, refundCents: 0, totalCents: 0, complete: false })
})

test('"minus zero" is read as zero, and no number of a position is ever -0', async () => {
  const position = await compute(ev({ paymentIntent: pi({ amount_received: -0 }), charge: charge({ amount_captured: 0 }) }))
  assert.equal(position.collectedCents, 0)
  assert.ok(Object.is(position.collectedCents, 0))
  bounds(position, 0, 0)
  assert.equal(position.certainty, 'proven')
  await assertWellFormed(position)
})

test('a canceled payment that nevertheless "received" money is contradictory: it is not "nothing was collected"', async () => {
  const position = await compute(ev({ paymentIntent: pi({ status: 'canceled', amount_received: 100 }) }))
  assert.ok(codesOf(position, 'conflict').includes('invalid_amount'), allCodes(position).join(', '))
  assert.equal(position.collectedCents, null)
  bounds(position, 0, null)
})

test('sums that leave the safe integers are refused, never rounded', async () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const position = await compute(ev({
    paymentIntent: pi({ amount: MAX, amount_received: MAX }),
    charge: charge({ amount: MAX, amount_captured: MAX, amount_refunded: MAX }),
    refunds: list([refund({ id: 're_a', amount: MAX }), refund({ id: 're_b', amount: MAX })]),
  }))
  assert.ok(codesOf(position, 'conflict').includes('invalid_amount'), allCodes(position).join(', '))
  assert.equal(position.retainedCents, null)
  assert.equal(position.refunds.confirmedCents, Number.MAX_SAFE_INTEGER, 'the sum that can not be represented stops at the largest safe integer: never a smaller, misleading figure')
  bounds(position, 0, Number.MAX_SAFE_INTEGER)
  await assertWellFormed(position)
})

// ---- currencies -------------------------------------------------------------------------------------------------------------------------------------------------------------
const BAD_CURRENCIES: Array<[string, unknown]> = [
  ['too long', 'euro'], ['too short', 'eu'], ['empty', ''], ['with a space', 'eu '], ['digits', '123'], ['a number', 978], ['null', null], ['missing', undefined],
]
const CURRENCY_TARGETS: Array<[string, (value: unknown) => unknown]> = [
  ['the payment', (value) => ev({ paymentIntent: pi({ currency: value }) })],
  ['the charge', (value) => ev({ charge: charge({ currency: value }) })],
  ['a refund', (value) => withRefunds([refund({ currency: value })], 0)],
  ['the movement of a refund', (value) => withRefunds([refund({ balance_transaction: bt({ id: 'txn_x', amount: -20, fee: 0, net: -20, currency: value, type: 'refund', reporting_category: 'refund', source: 're_1' }) })], 0)],
  ['a dispute', (value) => withDisputes([dispute({ currency: value })])],
  ['the movement of a dispute', (value) => withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { currency: value })] })])],
]
for (const [target, build] of CURRENCY_TARGETS) {
  for (const [name, value] of BAD_CURRENCIES) {
    test(`currency of ${target} - ${name}`, async () => {
      const position = await compute(build(value))
      assert.deepEqual(allCodes(position), ['conflict:invalid_currency'])
      assert.equal(position.retainedCents, null)
      assert.equal(position.currency, target === 'the payment' ? null : 'eur')
      await assertWellFormed(position, `${target} ${name}`)
    })
  }
  test(`currency of ${target} - capital letters are the same currency`, async () => {
    const position = await compute(build('EUR'))
    assert.deepEqual(allCodes(position).filter((code) => code.startsWith('conflict:')), [])
    assert.equal(position.currency, 'eur')
  })
}

// ---- identifiers --------------------------------------------------------------------------------------------------------------------------------------------------------------
const BAD_IDS: Array<[string, unknown]> = [
  ['empty', ''], ['with spaces', 're 1'], ['with a slash', 're/1'], ['markup', '<b>re_1</b>'], ['a number', 7], ['null', null], ['missing', undefined], ['too long', `re_${'x'.repeat(300)}`],
]
const ID_TARGETS: Array<[string, (value: unknown) => unknown, number]> = [
  ['the payment', (value) => ev({ paymentIntent: pi({ id: value }) }), 100],
  ['the charge', (value) => ev({ charge: charge({ id: value }) }), 100],
  ['a refund', (value) => withRefunds([refund({ id: value })], 0), 100],
  ['a dispute', (value) => withDisputes([dispute({ id: value })]), 100],
  ['a movement', (value) => withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { id: value })] })]), 100],
]
for (const [target, build] of ID_TARGETS) {
  for (const [name, value] of BAD_IDS) {
    test(`identifier of ${target} - ${name}: what can not be named can not be counted once`, async () => {
      const position = await compute(build(value))
      assert.deepEqual(allCodes(position), ['conflict:invalid_identifier'])
      assert.equal(position.retainedCents, null)
      bounds(position, 0, 100)
      assert.ok(!JSON.stringify(position).includes('<b>'), 'text of the evidence does not travel into the position')
      await assertWellFormed(position, `${target} ${name}`)
    })
  }
}

test('free text of the evidence never travels into the position: an odd status is described by the model, not echoed', async () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const position = await compute(withRefunds([refund({ amount: 20, status: hostile })], 20, { disputes: list([dispute({ status: hostile, balance_transactions: [] })]), charge: charge({ amount_refunded: 20, disputed: true }) }))
  assert.ok(!JSON.stringify(position).includes('<img'))
  assert.equal(position.refunds.items[0].status, null)
  assert.equal(position.disputes.items[0].status, null)
})

// ---- shapes -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const GARBAGE_SHAPES: Array<{ name: string; evidence: () => unknown; codes: string[]; lower: number; upper: number | null }> = [
  { name: 'refunds whose entries are not objects', evidence: () => ev({ refunds: list([null, 5, 'x']) }), codes: ['conflict:invalid_evidence'], lower: 0, upper: 100 },
  { name: 'disputes whose entries are not objects', evidence: () => ev({ disputes: list([null]), charge: charge({ disputed: true }) }), codes: ['conflict:invalid_evidence', 'uncertainty:disputed_charge_without_dispute'], lower: 0, upper: 100 },
  { name: 'a movement that is not an object', evidence: () => withDisputes([dispute({ balance_transactions: [null] })]), codes: ['conflict:invalid_evidence'], lower: 0, upper: 100 },
  { name: 'movements that are not a list (a string)', evidence: () => withDisputes([dispute({ balance_transactions: 'txn_1' })]), codes: ['uncertainty:dispute_movements_not_read'], lower: 0, upper: 100 },
  { name: 'a payment that is only an id (not expanded)', evidence: () => ev({ paymentIntent: PI }), codes: ['uncertainty:payment_intent_missing'], lower: 0, upper: null },
  { name: 'a charge that is only an id (not expanded)', evidence: () => ev({ charge: CH }), codes: ['uncertainty:dispute_state_unknown', 'uncertainty:refund_total_not_read'], lower: 0, upper: 100 },
]
for (const scenario of GARBAGE_SHAPES) {
  test(`a shape that is not what it must be - ${scenario.name}`, async () => {
    const position = await compute(scenario.evidence())
    assert.deepEqual(allCodes(position), scenario.codes)
    bounds(position, scenario.lower, scenario.upper)
    assert.equal(position.retainedCents, null)
    await assertWellFormed(position, scenario.name)
  })
}

test('evidence that throws when it is READ is never a reliable position and never an exception', async () => {
  const hostile = { get paymentIntent(): never { throw new Error('boom') }, charge: charge(), refunds: list([]), disputes: list([]) }
  const position = await compute(hostile)
  assert.deepEqual(allCodes(position), ['conflict:invalid_evidence'])
  bounds(position, 0, null)
  assert.equal(position.retainedCents, null)
  assert.equal(position.final, false)
  await assertWellFormed(position)
  const deep = ev({ refunds: { get data(): never { throw new Error('boom') }, has_more: false } })
  assert.deepEqual(allCodes(await compute(deep)), ['conflict:invalid_evidence'])
})

test('retainedAtLeast and retainedIsZero answer "unknown" to an amount that is not a whole non-negative number of cents, and to a position that is not one', async () => {
  const { retainedAtLeast, retainedIsZero } = await load()
  const position = await compute(ev())
  for (const amount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '10', null, undefined, {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(retainedAtLeast(position, amount as number), 'unknown', String(amount))
  }
  const upside = { ...position, retainedLowerCents: 50, retainedUpperCents: 10 }
  assert.equal(retainedAtLeast(upside, 1), 'unknown', 'a position whose best reading is below its worst is not a position')
  assert.equal(retainedIsZero({ ...upside, certainty: 'proven', retainedLowerCents: 0, retainedUpperCents: -1 }), 'unknown')
  for (const notAPosition of [null, undefined, {}, 'position', 5, { retainedLowerCents: 'x' }]) {
    assert.equal(retainedAtLeast(notAPosition as unknown as FundsPosition, 1), 'unknown', JSON.stringify(notAPosition))
    assert.equal(retainedIsZero(notAPosition as unknown as FundsPosition), 'unknown', JSON.stringify(notAPosition))
  }
})

// =====================================================================================================================================================================
// 15. Purity, determinism, and what must hold for ANY evidence
// =====================================================================================================================================================================
const ROOT = process.cwd()
const MODULE_FILE = 'lib/payment-hold-evidence.ts'
const readSource = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const FORBIDDEN_IN_THE_MODEL: Array<[string, RegExp]> = [
  ['an import, a re-export or a require (the model needs nothing: not even a type)', /(^|\n)\s*import[\s({]|\brequire\s*\(|\bexport\s+\*\s+from\b|\bexport\s+(type\s+)?\{[^}]*\}\s+from\b/],
  ['the clock', /\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/],
  ['randomness', /\bMath\.random\b|\bcrypto\b|\brandomUUID\b|\brandomBytes\b/],
  ['the environment', /\bprocess\b|\bglobalThis\b|\bwindow\b|\bdocument\b|\bimport\.meta\b|\bBuffer\b/],
  ['the network or the disk', /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bhttps?:\/\/|\bfs\./],
  ['asynchrony', /\basync\b|\bawait\b|\bPromise\b|\.then\s*\(/],
  ['output', /\bconsole\b|\bdebugger\b/],
  ['floating point or rounding for money', /\btoFixed\b|\bparseFloat\b|\bparseInt\b|\bNumber\.parse|\bMath\.(round|floor|ceil|trunc|fround)\b/],
  ['state kept between calls (a mutable binding at module level)', /^(let|var)\s/m],
]
test('the model is PURE: no import, no clock, no randomness, no environment, no network, no disk, no asynchrony, no output, no rounding, no state between calls', () => {
  const model = stripComments(readSource(MODULE_FILE))
  for (const [what, pattern] of FORBIDDEN_IN_THE_MODEL) assert.ok(!pattern.test(model), `the model uses ${what}: ${String(pattern)}`)
})

test('the public surface is small and fixed: one function, two questions, and the list of the findings it can make', async () => {
  assert.deepEqual(Object.keys(await load()).sort(), ['FUNDS_FINDING_CODES', 'computeFundsPosition', 'retainedAtLeast', 'retainedIsZero'])
})

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!['node_modules', '.next', '.git'].includes(entry.name)) sourceFiles(full, into)
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) into.push(full)
  }
  return into
}
// P1 is verified IN ISOLATION first: no code of the application knows the module. A package that is authorized to wire it changes this list on purpose.
const ALLOWED_IMPORTERS: string[] = []
test('P1 is not wired into any code that takes operational decisions: nothing in app/, lib/, components/, scripts/, prisma/ or at the root names the module', () => {
  const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map((entry) => entry.name)
  const files = [...rootFiles, ...['app', 'lib', 'components', 'scripts', 'prisma'].filter((dir) => fs.existsSync(path.join(ROOT, dir))).flatMap((dir) => sourceFiles(dir))]
  assert.deepEqual(files.filter((file) => file !== MODULE_FILE && readSource(file).includes('payment-hold-evidence')), ALLOWED_IMPORTERS)
  for (const file of ['lib/payment-hold.ts', 'lib/payment-sync.ts', 'lib/order-payment-policy.ts', 'lib/production-release.ts', 'lib/payment-verification.ts', 'lib/stripe-webhook.ts']) {
    assert.ok(!readSource(file).includes('payment-hold-evidence'), `${file} must not know the model yet`)
  }
})

// ---- a seeded generator (no clock, no Math.random: a failure can always be replayed) ---------------------------------------------------------------------------------
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
const between = (random: Random, min: number, max: number) => min + Math.floor(random() * (max - min + 1))
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]
function shuffled<T>(random: Random, items: readonly T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const held = copy[index]
    copy[index] = copy[other]
    copy[other] = held
  }
  return copy
}
type Loose = { refunds?: { data?: unknown[] } | null; disputes?: { data?: Array<Record<string, unknown>> } | null; requestedRefunds?: unknown[] | null }
// the same evidence with every list in another order
function permuted(random: Random, evidence: unknown): unknown {
  const copy = deepClone(evidence) as Loose
  const refunds = copy.refunds
  if (refunds && Array.isArray(refunds.data)) refunds.data = shuffled(random, refunds.data)
  const disputes = copy.disputes
  if (disputes && Array.isArray(disputes.data)) {
    disputes.data = shuffled(random, disputes.data)
    for (const entry of disputes.data) if (entry && Array.isArray(entry.balance_transactions)) entry.balance_transactions = shuffled(random, entry.balance_transactions)
  }
  if (Array.isArray(copy.requestedRefunds)) copy.requestedRefunds = shuffled(random, copy.requestedRefunds)
  return copy
}

// ---- one payment with every moving part ------------------------------------------------------------------------------------------------------------------------------------
const richEvidence = () => ev({
  paymentIntent: pi({ amount: 10_000, amount_received: 10_000 }),
  charge: charge({ amount: 10_000, amount_captured: 10_000, amount_refunded: 1_500, disputed: true }),
  refunds: list([
    refund({ id: 're_a', amount: 1_000 }),
    refund({ id: 're_b', amount: 500, status: 'pending' }),
    failedRefund({ id: 're_c', amount: 700 }),
    refund({ id: 're_a', amount: 1_000 }),
  ]),
  disputes: list([
    dispute({ id: 'dp_1', amount: 2_000, status: 'lost', balance_transactions: [withdrawal(2_000, 1_500, { id: 'txn_w1', source: 'dp_1' })] }),
    dispute({ id: 'dp_2', amount: 3_000, status: 'won', balance_transactions: [withdrawal(3_000, 1_500, { id: 'txn_w2', source: 'dp_2' }), reinstatement(3_000, 0, { id: 'txn_r2', source: 'dp_2' })] }),
  ]),
  requestedRefunds: [{ id: 're_b', amount: 500 }],
})

test('a payment with every moving part at once - succeeded, pending and failed refunds, a duplicate, a request, a lost dispute and a won one - has exactly this position', async () => {
  const position = await compute(richEvidence())
  bounds(position, 6_500, 7_000)
  assert.deepEqual(allCodes(position), ['note:duplicate_removed', 'uncertainty:refund_in_flight'])
  assert.deepEqual(position.refunds, {
    confirmedCents: 1_000, inFlightCents: 500, unknownCents: 0, requestedCents: 0, reversedCents: 700, reportedByChargeCents: 1_500,
    items: [
      { id: 're_a', amountCents: 1_000, status: 'succeeded', outcome: 'effective', feeCents: 0 },
      { id: 're_b', amountCents: 500, status: 'pending', outcome: 'in_flight', feeCents: 0 },
      { id: 're_c', amountCents: 700, status: 'failed', outcome: 'not_effective', feeCents: 0 },
    ],
  })
  assert.deepEqual(position.disputes, {
    withdrawnCents: 5_000, reinstatedCents: 3_000, fundsGoneLowerCents: 2_000, fundsGoneUpperCents: 2_000,
    items: [
      { id: 'dp_1', amountCents: 2_000, status: 'lost', phase: 'lost', withdrawnCents: 2_000, reinstatedCents: 0, feeCents: 1_500 },
      { id: 'dp_2', amountCents: 3_000, status: 'won', phase: 'won', withdrawnCents: 3_000, reinstatedCents: 3_000, feeCents: 1_500 },
    ],
  })
  assert.deepEqual(position.fees, { disputeCents: 3_000, refundCents: 0, totalCents: 3_000, complete: false })
  assert.equal(position.collectedCents, 10_000)
  assert.equal(position.provisionalRefundCents, 1_000)
  assert.equal(position.overRecoveredCents, 0)
  assert.equal(position.certainty, 'uncertain')
  assert.equal(position.final, false)
  await assertWellFormed(position)
})

test('the same evidence gives the same position every time, with other evidence computed in between: there is no hidden state', async () => {
  const base = await compute(richEvidence())
  for (let round = 0; round < 25; round++) {
    await compute(withRefunds([refund({ status: 'pending' })], 20))
    await compute(null)
    assert.deepEqual(await compute(richEvidence()), base)
  }
})

test('the input is neither modified nor kept: frozen evidence is read without a write, and changing the input afterwards does not change the position', async () => {
  const frozen = deepFreeze(richEvidence())
  const before = deepClone(frozen)
  const fromFrozen = await compute(frozen)
  assert.deepEqual(deepClone(frozen), before)
  assert.deepEqual(fromFrozen, await compute(richEvidence()), 'read-only evidence gives the same position as any other')
  const untouched = richEvidence()
  const untouchedBefore = deepClone(untouched)
  await compute(untouched)
  assert.deepEqual(deepClone(untouched), untouchedBefore, 'nothing written into the evidence: not an order, not a flag, not a field')
  const loose = richEvidence()
  const position = await compute(loose)
  const snapshot = deepClone(position)
  ;(loose.refunds as unknown as { data: Array<{ amount: number }> }).data[0].amount = 999
  ;(loose.disputes as unknown as { data: Array<{ status: string }> }).data[0].status = 'won'
  assert.deepEqual(position, snapshot)
})

const DIRTY_EVIDENCE: Array<[string, () => unknown]> = [
  ['a rich payment', richEvidence],
  ['duplicates of refunds', () => withRefunds([refund({ amount: 20 }), refund({ amount: 20 }), refund({ id: 're_b', amount: 30 })], 50)],
  ['a refund described twice in two ways', () => withRefunds([refund({ amount: 20 }), refund({ amount: 30 }), refund({ id: 're_b', amount: 5 })], 25)],
  ['a foreign refund among good ones', () => withRefunds([refund({ id: 're_a', amount: 20 }), refund({ id: 're_f', payment_intent: 'pi_other' }), refund({ id: 're_b', amount: 5, status: 'pending' })], 25)],
  ['a dispute with duplicated movements next to a won one', () => withDisputes([
    dispute({ balance_transactions: [withdrawal(100, 2000), withdrawal(100, 2000)] }),
    dispute({ id: 'dp_2', status: 'won', amount: 50, balance_transactions: [withdrawal(50, 100, { id: 'txn_a', source: 'dp_2' }), reinstatement(50, 0, { id: 'txn_b', source: 'dp_2' })] }),
  ])],
  ['requests among listed refunds', () => ev({ refunds: list([refund({ id: 're_a', amount: 20 }), refund({ id: 're_b', amount: 5, status: 'pending' })]), charge: charge({ amount_refunded: 25 }), requestedRefunds: [{ amount: 7 }, { id: 're_b', amount: 5 }, { amount: 3 }] })],
  // P1-bis (A): requests that disagree with a listed refund and with each other - the id that two requests describe in two ways used to be settled by whichever came first
  ['requests that contradict a listed refund and each other', () => ev({
    refunds: list([refund({ id: 're_a', amount: 20 }), refund({ id: 're_b', amount: 30 })]), charge: charge({ amount_refunded: 50 }),
    requestedRefunds: [{ id: 're_b', amount: 31 }, { id: 're_a', amount: 20 }, { id: 're_c', amount: 5 }, { id: 're_c', amount: 6 }, { amount: 4 }],
  })],
]
for (const [name, build] of DIRTY_EVIDENCE) {
  test(`the order of the lists changes nothing - ${name}`, async () => {
    const base = await compute(deepClone(build()))
    for (let seed = 1; seed <= 25; seed++) assert.deepEqual(await compute(permuted(mulberry32(seed), build())), base, `order ${seed}`)
  })
}

// ---- properties over generated evidence ---------------------------------------------------------------------------------------------------------------------------------
// A world in which EVERYTHING is shown and consistent: refunds succeeded or failed (with their reversal), disputes lost or won (with their movements), amounts and fees at random.
// The independent expectation is plain arithmetic: collected - refunded - lost, floored at zero.
type World = { evidence: Record<string, unknown>; collected: number; confirmed: number; lost: number; refundFees: number; disputeFees: number }
function provenWorld(random: Random): World {
  const collected = between(random, 6_000, 20_000)
  const refunds: unknown[] = []
  let confirmed = 0
  let refundFees = 0
  for (let index = 0, count = between(random, 0, 4); index < count; index++) {
    const id = `re_${index}`
    const amount = between(random, 1, 6_000)
    if (random() < 0.7) {
      const fee = between(random, 0, 50)
      refunds.push(refund({ id, amount, balance_transaction: bt({ id: `txn_${id}`, amount: -amount, fee, net: -amount - fee, type: 'refund', reporting_category: 'refund', source: id }) }))
      confirmed += amount
      refundFees += fee
    } else refunds.push(failedRefund({ id, amount }))
  }
  const disputes: unknown[] = []
  let lost = 0
  let disputeFees = 0
  for (let index = 0, count = between(random, 0, 2); index < count; index++) {
    const id = `dp_${index}`
    const amount = between(random, 1, 6_000)
    const fee = between(random, 0, 5_000)
    const won = random() < 0.5
    const backFee = won ? between(random, 0, 50) : 0
    disputes.push(dispute({
      id, amount, status: won ? 'won' : 'lost',
      balance_transactions: [withdrawal(amount, fee, { id: `txn_w${index}`, source: id }), ...(won ? [reinstatement(amount, backFee, { id: `txn_r${index}`, source: id })] : [])],
    }))
    disputeFees += fee + backFee
    if (!won) lost += amount
  }
  const evidence = ev({
    paymentIntent: pi({ amount: collected, amount_received: collected }),
    charge: charge({ amount: collected, amount_captured: collected, amount_refunded: confirmed, disputed: disputes.length > 0 }),
    refunds: list(refunds),
    disputes: list(disputes),
  })
  return { evidence, collected, confirmed, lost, refundFees, disputeFees }
}

test('property (300 worlds): when everything is shown and consistent the position is exactly collected - refunded - lost, floored at zero; fees are only fees', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const world = provenWorld(mulberry32(seed))
    const position = await compute(world.evidence)
    const label = `seed ${seed}`
    const retained = Math.max(0, world.collected - world.confirmed - world.lost)
    const over = Math.max(0, world.confirmed + world.lost - world.collected)
    assert.deepEqual(allCodes(position), over > 0 ? ['anomaly:over_recovered'] : [], label)
    assert.equal(position.certainty, 'proven', label)
    bounds(position, retained, retained, label)
    assert.equal(position.retainedCents, retained, label)
    assert.equal(position.refunds.confirmedCents, world.confirmed, label)
    assert.equal(position.provisionalRefundCents, world.confirmed, label)
    assert.equal(position.final, world.confirmed === 0, label)
    assert.equal(position.overRecoveredCents, over, label)
    assert.equal(position.fees.disputeCents, world.disputeFees, label)
    assert.equal(position.fees.refundCents, world.refundFees, label)
    assert.equal(position.fees.complete, true, label)
    await assertWellFormed(position, label)
  }
})

// every balance transaction gets another fee, and the net that goes with it
function refeed(random: Random, node: unknown): void {
  if (Array.isArray(node)) for (const child of node) refeed(random, child)
  else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record.amount === 'number' && typeof record.fee === 'number' && typeof record.net === 'number') {
      const amount = record.amount
      const fee = between(random, 0, 100_000)
      record.fee = fee
      record.net = amount - fee
    }
    for (const child of Object.values(record)) refeed(random, child)
  }
}
const withoutFees = (position: FundsPosition) => ({
  ...position,
  fees: null,
  refunds: { ...position.refunds, items: position.refunds.items.map((item) => ({ ...item, feeCents: 0 })) },
  disputes: { ...position.disputes, items: position.disputes.items.map((item) => ({ ...item, feeCents: 0 })) },
})
test('property (300 worlds): a fee never changes the capital, the bounds, the certainty or a finding - whatever it is', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const world = provenWorld(mulberry32(seed))
    const base = await compute(deepClone(world.evidence))
    const changed = deepClone(world.evidence)
    refeed(mulberry32(seed + 1_000), changed)
    const other = await compute(changed)
    assert.deepEqual(withoutFees(other), withoutFees(base), `seed ${seed}`)
  }
})

test('property (300 worlds): the same refund or dispute listed twice changes nothing but one note', async () => {
  const withoutNote = (position: FundsPosition) => ({ ...position, findings: position.findings.filter((entry) => entry.code !== 'duplicate_removed') })
  for (let seed = 1; seed <= 300; seed++) {
    const world = provenWorld(mulberry32(seed))
    const base = await compute(deepClone(world.evidence))
    const twice = deepClone(world.evidence) as { refunds: { data: unknown[] }; disputes: { data: unknown[] } }
    twice.refunds.data = [...twice.refunds.data, ...twice.refunds.data.slice(0, 1)]
    twice.disputes.data = [...twice.disputes.data, ...twice.disputes.data.slice(0, 1)]
    const other = await compute(twice)
    assert.deepEqual(withoutNote(other), withoutNote(base), `seed ${seed}`)
    const added = (twice.refunds.data.length > (world.evidence.refunds as { data: unknown[] }).data.length ? 1 : 0) + (twice.disputes.data.length > (world.evidence.disputes as { data: unknown[] }).data.length ? 1 : 0)
    assert.equal(other.findings.filter((entry) => entry.code === 'duplicate_removed').length, added, `seed ${seed}`)
  }
})

test('property (300 worlds): more money out never means more money held - one more succeeded refund, or one more lost dispute, never raises a bound', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = mulberry32(seed)
    const world = provenWorld(random)
    const base = await compute(deepClone(world.evidence))
    const more = deepClone(world.evidence) as { refunds: { data: unknown[] }; disputes: { data: unknown[] }; charge: { amount_refunded: number; disputed: boolean } }
    const amount = between(random, 1, 3_000)
    more.refunds.data.push(refund({ id: 're_more', amount }))
    more.charge.amount_refunded += amount
    const refunded = await compute(more)
    assert.ok(refunded.retainedLowerCents <= base.retainedLowerCents, `seed ${seed} refund, lower`)
    assert.ok((refunded.retainedUpperCents ?? 0) <= (base.retainedUpperCents ?? 0), `seed ${seed} refund, upper`)
    const taken = deepClone(world.evidence) as typeof more
    taken.disputes.data.push(dispute({ id: 'dp_more', amount, status: 'lost', balance_transactions: [withdrawal(amount, 100, { id: 'txn_more', source: 'dp_more' })] }))
    taken.charge.disputed = true
    const lost = await compute(taken)
    assert.ok(lost.retainedLowerCents <= base.retainedLowerCents, `seed ${seed} dispute, lower`)
    assert.ok((lost.retainedUpperCents ?? 0) <= (base.retainedUpperCents ?? 0), `seed ${seed} dispute, upper`)
  }
})

// Evidence that gets WORSE can never make the position better: the lower bound does not rise, the upper bound does not fall, a proven position does not stay proven, and nothing becomes final.
type Draft = {
  paymentIntent: Record<string, unknown> | null
  charge: Record<string, unknown> | null
  refunds: { data: Array<Record<string, unknown>>; has_more?: boolean } | null
  disputes: { data: Array<Record<string, unknown>>; has_more?: boolean } | null
}
const DEGRADATIONS: Array<{ name: string; apply: (draft: Draft) => boolean }> = [
  { name: 'the refunds list says there is more', apply: (draft) => { if (!draft.refunds) return false; draft.refunds.has_more = true; return true } },
  { name: 'the refunds list is missing', apply: (draft) => { draft.refunds = null; return true } },
  { name: 'the charge is missing', apply: (draft) => { draft.charge = null; return true } },
  { name: 'the payment is still processing', apply: (draft) => { if (!draft.paymentIntent) return false; draft.paymentIntent.status = 'processing'; return true } },
  { name: 'a succeeded refund is only pending', apply: (draft) => { const target = draft.refunds?.data.find((entry) => entry.status === 'succeeded'); if (!target) return false; target.status = 'pending'; target.balance_transaction = null; return true } },
  { name: 'a succeeded refund has a status nobody knows', apply: (draft) => { const target = draft.refunds?.data.find((entry) => entry.status === 'succeeded'); if (!target) return false; target.status = 'zzz'; return true } },
  { name: 'a failed refund shows no reversal', apply: (draft) => { const target = draft.refunds?.data.find((entry) => entry.status === 'failed'); if (!target) return false; target.failure_balance_transaction = null; return true } },
  { name: 'the disputes list says there is more', apply: (draft) => { if (!draft.disputes) return false; draft.disputes.has_more = true; return true } },
  { name: 'the disputes list is missing', apply: (draft) => { draft.disputes = null; return true } },
  { name: 'a dispute is in a status nobody modeled', apply: (draft) => { const target = draft.disputes?.data[0]; if (!target) return false; target.status = 'warning_closed'; return true } },
  { name: 'a dispute is still open', apply: (draft) => { const target = draft.disputes?.data[0]; if (!target) return false; target.status = 'needs_response'; return true } },
  { name: 'the movements of a dispute were not read', apply: (draft) => { const target = draft.disputes?.data[0]; if (!target) return false; target.balance_transactions = null; return true } },
  { name: 'the reinstatement of a won dispute is not shown', apply: (draft) => { const target = draft.disputes?.data.find((entry) => entry.status === 'won'); if (!target) return false; target.balance_transactions = (target.balance_transactions as unknown[]).slice(0, 1); return true } },
]
for (const degradation of DEGRADATIONS) {
  test(`property (300 worlds): evidence that gets worse never makes the position better - ${degradation.name}`, async () => {
    const { retainedAtLeast, retainedIsZero } = await load()
    let applied = 0
    for (let seed = 1; seed <= 300; seed++) {
      const world = provenWorld(mulberry32(seed))
      const before = await compute(deepClone(world.evidence))
      const draft = deepClone(world.evidence) as unknown as Draft
      if (!degradation.apply(draft)) continue
      applied++
      const after = await compute(draft)
      const label = `seed ${seed}`
      assert.ok(after.retainedLowerCents <= before.retainedLowerCents, `${label} the lower bound went up`)
      assert.ok(after.retainedUpperCents === null || (before.retainedUpperCents !== null && after.retainedUpperCents >= before.retainedUpperCents), `${label} the upper bound went down`)
      assert.equal(after.certainty, 'uncertain', `${label} the position stayed proven`)
      assert.equal(after.final, false, label)
      assert.notEqual(retainedIsZero(after), 'yes', `${label} zero is claimed from a degraded position`)
      for (const wanted of [1, before.retainedLowerCents, before.retainedLowerCents + 1]) {
        if (retainedAtLeast(after, wanted) === 'yes') assert.equal(retainedAtLeast(before, wanted), 'yes', `${label} coverage of ${wanted} appeared`)
      }
      await assertWellFormed(after, label)
    }
    assert.ok(applied >= 50, `the degradation applied to only ${applied} worlds: the property is not exercised`)
  })
}

// ---- evidence that is random, incomplete and wrong -------------------------------------------------------------------------------------------------------------------------
function chaosWorld(random: Random): Record<string, unknown> {
  const status = pick(random, ['succeeded', 'succeeded', 'succeeded', 'canceled', 'processing', 'requires_action', 'zzz'])
  const collected = between(random, 0, 15_000)
  const received = status === 'succeeded' ? collected : 0
  const refunds = Array.from({ length: between(random, 0, 4) }, (_, index) => {
    const id = `re_${index}`
    const amount = between(random, 1, 8_000)
    const state = pick(random, ['succeeded', 'succeeded', 'pending', 'requires_action', 'failed', 'canceled', 'zzz'])
    if (state === 'failed' || state === 'canceled') return random() < 0.5 ? failedRefund({ id, amount, status: state }) : refund({ id, amount, status: state })
    return refund({ id, amount, status: state, ...(random() < 0.1 ? { payment_intent: 'pi_other' } : {}) })
  })
  const disputes = Array.from({ length: between(random, 0, 2) }, (_, index) => {
    const id = `dp_${index}`
    const amount = between(random, 1, 8_000)
    const state = pick(random, ['lost', 'lost', 'won', 'needs_response', 'under_review', 'warning_closed', 'zzz'])
    const shown = pick(random, ['none', 'withdrawal', 'both', 'partial', 'unread'])
    const movements: unknown[] | null = shown === 'unread' ? null
      : shown === 'none' ? []
        : shown === 'withdrawal' ? [withdrawal(amount, between(random, 0, 3_000), { id: `txn_w${index}`, source: id })]
          : shown === 'partial' ? [withdrawal(Math.max(1, Math.floor(amount / 2)), 100, { id: `txn_w${index}`, source: id })]
            : [withdrawal(amount, between(random, 0, 3_000), { id: `txn_w${index}`, source: id }), reinstatement(amount, 0, { id: `txn_r${index}`, source: id })]
    return dispute({ id, amount, status: state, balance_transactions: movements })
  })
  return ev({
    paymentIntent: pi({ amount: collected, amount_received: received, status }),
    charge: random() < 0.1 ? null : charge({ amount: collected, amount_captured: received, amount_refunded: between(random, 0, 12_000), disputed: random() < 0.5 }),
    refunds: random() < 0.08 ? null : list(refunds, random() < 0.1),
    disputes: random() < 0.08 ? null : list(disputes, random() < 0.1),
    requestedRefunds: random() < 0.3 ? [{ amount: between(random, 1, 3_000) }] : undefined,
  })
}
const GARBAGE_VALUES: unknown[] = [null, 'x', '', -1, 0, 0.5, 1e308, true, {}, [], 'pi_other', 'usd']
// the same evidence with one to three values replaced by something that is not what it should be
function corrupt(random: Random, world: unknown): unknown {
  const copy = deepClone(world)
  const places: Array<{ parent: Record<string | number, unknown>; key: string | number }> = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) node.forEach((child, index) => { places.push({ parent: node as unknown as Record<number, unknown>, key: index }); visit(child) })
    else if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) { places.push({ parent: node as Record<string, unknown>, key }); visit(child) }
  }
  visit(copy)
  for (let hits = between(random, 1, 3); hits > 0 && places.length > 0; hits--) {
    const place = pick(random, places)
    place.parent[place.key] = pick(random, GARBAGE_VALUES)
  }
  return copy
}
test('property (600 worlds, half of them corrupted): for ANY evidence the position is well formed, repeatable and independent of the order of the lists - and nothing throws', async () => {
  for (let seed = 1; seed <= 600; seed++) {
    const random = mulberry32(seed * 7_919)
    const world = chaosWorld(random)
    const evidence = seed % 2 === 0 ? corrupt(random, world) : deepClone(world)
    const label = `seed ${seed}`
    const first = await compute(evidence)
    await assertWellFormed(first, label)
    assert.deepEqual(await compute(evidence), first, `${label} repeatable`)
    assert.deepEqual(await compute(permuted(mulberry32(seed), evidence)), first, `${label} order of the lists`)
  }
})

// ---- the findings ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const CODE_SCENARIOS: Record<string, () => unknown> = {
  payment_intent_missing: () => ({}),
  payment_open: () => ev({ paymentIntent: pi({ status: 'requires_payment_method', amount_received: 0 }), charge: charge({ amount_captured: 0 }) }),
  payment_in_motion: () => ev({ paymentIntent: pi({ status: 'processing', amount_received: 0 }), charge: charge({ amount_captured: 0 }) }),
  payment_status_unknown: () => ev({ paymentIntent: pi({ status: 'zzz', amount_received: 0 }), charge: charge({ amount_captured: 0 }) }),
  refunds_not_read: () => ev({ refunds: null }),
  refunds_incomplete: () => ev({ refunds: list([], true) }),
  refund_total_not_read: () => ev({ charge: charge({ amount_refunded: undefined }) }),
  refund_in_flight: () => withRefunds([refund({ status: 'pending' })], 20),
  refund_state_unknown: () => withRefunds([refund({ status: 'zzz' })], 20),
  refund_requested: () => ev({ requestedRefunds: [{ amount: 20 }] }),
  refunded_amount_unexplained: () => withRefunds([refund()], 50),
  refunded_amount_lagging: () => withRefunds([refund()], 0),
  refund_reversal_unproven: () => withRefunds([failedRefund({ failure_balance_transaction: null })], 0),
  refund_movements_unreadable: () => withRefunds([failedRefund({ balance_transaction: 'txn_x', failure_balance_transaction: 'txn_y' })], 0),
  disputes_not_read: () => ev({ disputes: null }),
  disputes_incomplete: () => ev({ disputes: list([], true) }),
  dispute_state_unknown: () => ev({ charge: charge({ disputed: undefined }) }),
  disputed_charge_without_dispute: () => ev({ charge: charge({ disputed: true }) }),
  dispute_open: () => withDisputes([dispute({ status: 'needs_response' })]),
  dispute_won_funds_not_returned: () => withDisputes([dispute({ status: 'won' })]),
  dispute_won_funds_not_shown: () => withDisputes([dispute({ status: 'won', balance_transactions: [] })]),
  dispute_lost_without_withdrawal: () => withDisputes([dispute({ balance_transactions: [] })]),
  dispute_withdrawal_incomplete: () => withDisputes([dispute({ balance_transactions: [withdrawal(60, 2000)] })]),
  dispute_status_not_modeled: () => withDisputes([dispute({ status: 'warning_closed' })]),
  dispute_movements_not_read: () => withDisputes([dispute({ balance_transactions: null })]),
  dispute_movements_unreadable: () => withDisputes([dispute({ balance_transactions: ['txn_a'] })]),
  invalid_evidence: () => ev({ refunds: list([null]) }),
  invalid_identifier: () => withRefunds([refund({ id: '' })], 0),
  invalid_amount: () => withRefunds([refund({ amount: -1 })], 0),
  invalid_currency: () => ev({ paymentIntent: pi({ currency: 'euro' }) }),
  currency_mismatch: () => withRefunds([refund({ currency: 'usd' })], 20),
  foreign_evidence: () => withRefunds([refund({ payment_intent: 'pi_other' })], 0),
  unattributable_evidence: () => withRefunds([refund({ payment_intent: null, charge: null })], 0),
  conflicting_duplicate: () => withRefunds([refund({ amount: 20 }), refund({ amount: 30 })], 20),
  balance_transaction_inconsistent: () => withRefunds([refund({ balance_transaction: bt({ id: 'txn_re_1', amount: -20, fee: 0, net: -25, type: 'refund', reporting_category: 'refund', source: 're_1' }) })], 20),
  unrecognized_movement: () => withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { reporting_category: 'x' })] })]),
  charge_mismatch: () => ev({ charge: charge({ payment_intent: 'pi_other' }) }),
  dispute_flag_mismatch: () => ev({ disputes: list([dispute()]), charge: charge({ disputed: false }) }),
  dispute_amounts_inconsistent: () => withDisputes([dispute({ balance_transactions: [withdrawal(150, 2000)] })]),
  over_recovered: () => withRefunds([refund({ amount: 120 })], 120),
  duplicate_removed: () => withRefunds([refund(), refund()], 20),
  state_not_observed: () => withRefunds([failedRefund({ status: 'canceled' })], 0),
}
// the findings come in a fixed order - conflicts, uncertainties, anomalies, notes; then by code, then by reference (none first) - and none twice
const KIND_RANK: Record<string, number> = { conflict: 0, uncertainty: 1, anomaly: 2, note: 3 }
function assertOrdered(position: FundsPosition, label: string) {
  const keys = position.findings.map((entry) => [KIND_RANK[entry.kind], entry.code, entry.ref ?? ''] as const)
  const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
  const sorted = [...keys].sort((a, b) => a[0] - b[0] || order(a[1], b[1]) || order(a[2], b[2]))
  assert.deepEqual(keys, sorted, `${label} order`)
  assert.equal(new Set(keys.map((key) => key.join('|'))).size, keys.length, `${label} a finding twice`)
}
// What each finding MEANS, stated here once and independently of the model: an uncertainty or a conflict makes the position uncertain; an anomaly or a note does not.
const EXPECTED_KINDS: Record<string, string> = {
  payment_intent_missing: 'uncertainty', payment_open: 'uncertainty', payment_in_motion: 'uncertainty', payment_status_unknown: 'uncertainty',
  refunds_not_read: 'uncertainty', refunds_incomplete: 'uncertainty', refund_total_not_read: 'uncertainty', refund_in_flight: 'uncertainty', refund_state_unknown: 'uncertainty',
  refund_requested: 'uncertainty', refunded_amount_unexplained: 'uncertainty', refunded_amount_lagging: 'uncertainty', refund_reversal_unproven: 'uncertainty', refund_movements_unreadable: 'uncertainty',
  disputes_not_read: 'uncertainty', disputes_incomplete: 'uncertainty', dispute_state_unknown: 'uncertainty', disputed_charge_without_dispute: 'uncertainty', dispute_open: 'uncertainty',
  dispute_won_funds_not_returned: 'uncertainty', dispute_won_funds_not_shown: 'uncertainty', dispute_lost_without_withdrawal: 'uncertainty', dispute_withdrawal_incomplete: 'uncertainty',
  dispute_status_not_modeled: 'uncertainty', dispute_movements_not_read: 'uncertainty', dispute_movements_unreadable: 'uncertainty',
  invalid_evidence: 'conflict', invalid_identifier: 'conflict', invalid_amount: 'conflict', invalid_currency: 'conflict', currency_mismatch: 'conflict', foreign_evidence: 'conflict',
  unattributable_evidence: 'conflict', conflicting_duplicate: 'conflict', balance_transaction_inconsistent: 'conflict', unrecognized_movement: 'conflict', charge_mismatch: 'conflict',
  dispute_flag_mismatch: 'conflict', dispute_amounts_inconsistent: 'conflict',
  over_recovered: 'anomaly',
  duplicate_removed: 'note', state_not_observed: 'note',
}
test('every finding code is registered with its kind, and every registered code is produced by one scenario: no dead code, no unregistered code', async () => {
  const { FUNDS_FINDING_CODES } = await load()
  const registry = FUNDS_FINDING_CODES as Record<string, string>
  assert.deepEqual({ ...registry }, EXPECTED_KINDS, 'the list of the findings, and what each one means')
  assert.deepEqual(Object.keys(CODE_SCENARIOS).sort(), Object.keys(registry).sort())
  for (const [code, build] of Object.entries(CODE_SCENARIOS)) {
    const position = await compute(build())
    const found = position.findings.filter((entry) => entry.code === code)
    assert.ok(found.length > 0, `the scenario of ${code} does not produce it (${allCodes(position).join(', ')})`)
    for (const entry of found) assert.equal(entry.kind, registry[code], code)
    assertOrdered(position, code)
    await assertWellFormed(position, code)
  }
  assertOrdered(await compute(richEvidence()), 'rich')
})

test('the four kinds mean what they say: only an uncertainty or a conflict makes a position uncertain; an anomaly or a note never does', async () => {
  const { FUNDS_FINDING_CODES } = await load()
  const registry = FUNDS_FINDING_CODES as Record<string, string>
  for (const [code, build] of Object.entries(CODE_SCENARIOS)) {
    if (registry[code] !== 'anomaly' && registry[code] !== 'note') continue
    const position = await compute(build())
    assert.equal(position.certainty, 'proven', code)
  }
  for (const [code, build] of Object.entries(CODE_SCENARIOS)) {
    if (registry[code] !== 'uncertainty' && registry[code] !== 'conflict') continue
    const position = await compute(build())
    assert.equal(position.certainty, 'uncertain', code)
    assert.equal(position.final, false, code)
    assert.equal(position.retainedCents, null, code)
  }
})

// ---- checked by tsc only: what the Stripe SDK returns is accepted as evidence without a cast -------------------------------------------------------------------------
function stripeObjectsAreEvidence(objects: { paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge; refunds: Stripe.ApiList<Stripe.Refund>; disputes: Stripe.ApiList<Stripe.Dispute>; movement: Stripe.BalanceTransaction }): FundsEvidence {
  const movement: BalanceTransactionEvidence = objects.movement
  const payment: PaymentIntentEvidence = objects.paymentIntent
  const charged: ChargeEvidence = objects.charge
  const refunded: RefundEvidence = objects.refunds.data[0]
  const disputed: DisputeEvidence = objects.disputes.data[0]
  void movement; void payment; void charged; void refunded; void disputed
  return { paymentIntent: objects.paymentIntent, charge: objects.charge, refunds: objects.refunds, disputes: objects.disputes }
}
test('the Stripe SDK objects are assignable to the evidence types (the proof is the compilation of this file)', () => {
  assert.equal(typeof stripeObjectsAreEvidence, 'function')
})

// =====================================================================================================================================================================
// 16. Pinned after the first mutation run: every test below guards a rule that a mutation of the model had shown to be unguarded (docs/VERIFICA-4.6.md S6a.19)
// =====================================================================================================================================================================
const refundMovement = (over: Record<string, unknown> = {}) => bt({ id: 'txn_re_1', amount: -20, fee: 0, net: -20, type: 'refund', reporting_category: 'refund', source: 're_1', ...over })
const reversalMovement = (over: Record<string, unknown> = {}) => bt({ id: 'txn_f_re_1', amount: 20, fee: 0, net: 20, type: 'refund_failure', reporting_category: 'refund_failure', source: 're_1', ...over })

// ---- references and identifiers that are malformed --------------------------------------------------------------------------------------------------------------------
const MALFORMED_CASES: Array<{ name: string; build: () => unknown; codes: string[]; setAside?: 'refund' | 'dispute' }> = [
  { name: 'a refund names a malformed payment', build: () => withRefunds([refund({ payment_intent: 'a b' })], 0), codes: ['conflict:invalid_identifier'], setAside: 'refund' },
  { name: 'a refund names a malformed charge', build: () => withRefunds([refund({ charge: 'a b' })], 0), codes: ['conflict:invalid_identifier'], setAside: 'refund' },
  { name: 'a refund names an object that has no id', build: () => withRefunds([refund({ payment_intent: {} })], 0), codes: ['conflict:invalid_identifier'], setAside: 'refund' },
  { name: 'a dispute names a malformed payment (and, with no usable dispute, the charge that says "disputed" has nothing to be checked against)', build: () => withDisputes([dispute({ payment_intent: 'a b' })]), codes: ['conflict:invalid_identifier', 'uncertainty:disputed_charge_without_dispute'], setAside: 'dispute' },
  { name: 'a dispute names a malformed charge', build: () => withDisputes([dispute({ charge: 'a b' })]), codes: ['conflict:invalid_identifier', 'uncertainty:disputed_charge_without_dispute'], setAside: 'dispute' },
  { name: 'the charge names a malformed payment', build: () => ev({ charge: charge({ payment_intent: 'a b' }) }), codes: ['conflict:invalid_identifier'] },
  { name: 'the payment names a malformed latest charge', build: () => ev({ paymentIntent: pi({ latest_charge: 'a b' }) }), codes: ['conflict:invalid_identifier'] },
  { name: 'the movement of a refund names a malformed source', build: () => withRefunds([refund({ balance_transaction: refundMovement({ source: 'a b' }) })], 0), codes: ['conflict:invalid_identifier'], setAside: 'refund' },
  { name: 'the movement of a dispute names a malformed source', build: () => withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { source: 'a b' })] })]), codes: ['conflict:invalid_identifier'], setAside: 'dispute' },
  { name: 'the movement of a refund is a text that is not an id', build: () => withRefunds([refund({ balance_transaction: 'a b' })], 0), codes: ['conflict:invalid_identifier'], setAside: 'refund' },
  { name: 'the failure movement of a refund is a text that is not an id', build: () => withRefunds([failedRefund({ failure_balance_transaction: 'a b' })], 0), codes: ['conflict:invalid_identifier'], setAside: 'refund' },
  { name: 'a movement of a dispute is a text that is not an id', build: () => withDisputes([dispute({ balance_transactions: ['a b'] })]), codes: ['conflict:invalid_identifier'], setAside: 'dispute' },
]
for (const scenario of MALFORMED_CASES) {
  test(`a malformed reference or identifier is a contradiction, never a guess - ${scenario.name}`, async () => {
    const position = await compute(scenario.build())
    assert.deepEqual([...new Set(allCodes(position))], scenario.codes)
    bounds(position, 0, 100)
    assert.equal(position.retainedCents, null)
    if (scenario.setAside === 'refund') assert.equal(position.refunds.items[0].outcome, 'excluded')
    if (scenario.setAside === 'dispute') assert.equal(position.disputes.items[0].phase, 'excluded')
    await assertWellFormed(position, scenario.name)
  })
}

for (const [name, value] of [['a number', 7], ['true', true], ['a list', []]] as Array<[string, unknown]>) {
  test(`a movement of a refund that is ${name} is not evidence`, async () => {
    for (const field of ['balance_transaction', 'failure_balance_transaction']) {
      const position = await compute(withRefunds([failedRefund({ [field]: value })], 0))
      assert.deepEqual(allCodes(position), ['conflict:invalid_evidence'], field)
      assert.equal(position.refunds.items[0].outcome, 'excluded', field)
      bounds(position, 0, 100)
    }
  })
}

for (const [name, value] of BAD_IDS) {
  test(`identifier of the movement of a refund, as its debit and as its reversal - ${name}`, async () => {
    const debit = await compute(withRefunds([refund({ balance_transaction: refundMovement({ id: value }) })], 0))
    assert.deepEqual(allCodes(debit), ['conflict:invalid_identifier'])
    assert.equal(debit.refunds.items[0].outcome, 'excluded')
    const reversal = await compute(withRefunds([failedRefund({ failure_balance_transaction: reversalMovement({ id: value }) })], 0))
    assert.deepEqual(allCodes(reversal), ['conflict:invalid_identifier'])
    assert.equal(reversal.refunds.items[0].outcome, 'excluded')
  })
}

for (const [name, value] of [['negative', -1], ['a fraction', 0.5], ['text', '100'], ['NaN', Number.NaN], ['beyond the safe integers', Number.MAX_SAFE_INTEGER + 1]] as Array<[string, unknown]>) {
  test(`amount captured by the charge - ${name}: it is contradictory, not "a different amount"`, async () => {
    const position = await compute(ev({ charge: charge({ amount_captured: value }) }))
    assert.deepEqual(allCodes(position), ['conflict:invalid_amount'])
    bounds(position, 0, 100)
  })
}

test('without a usable id of the payment nothing can be attributed or refused: the objects are read as they are, and the one contradiction is the id', async () => {
  const position = await compute(ev({ paymentIntent: pi({ id: 'a b' }), charge: charge({ disputed: true, amount_refunded: 20 }), refunds: list([refund()]), disputes: list([dispute({ amount: 80, balance_transactions: [withdrawal(80, 2000)] })]) }))
  assert.deepEqual(allCodes(position), ['conflict:invalid_identifier'])
  assert.equal(position.refunds.confirmedCents, 20)
  assert.equal(position.disputes.withdrawnCents, 80)
})

test('a refund that names only a charge is attributable through the latest charge of the payment even when the charge itself was not read', async () => {
  const position = await compute(ev({ charge: null, refunds: list([refund({ payment_intent: null })]) }))
  assert.deepEqual(allCodes(position), ['uncertainty:dispute_state_unknown', 'uncertainty:refund_total_not_read'])
  assert.equal(position.refunds.confirmedCents, 20)
  bounds(position, 0, 80)
})

test('a refund that names only a charge can not be attributed when no charge of the payment is known at all', async () => {
  const position = await compute(ev({ paymentIntent: pi({ latest_charge: null }), charge: null, refunds: list([refund({ payment_intent: null })]) }))
  assert.ok(codesOf(position, 'conflict').includes('unattributable_evidence'), allCodes(position).join(', '))
  assert.equal(position.refunds.items[0].outcome, 'excluded')
})

test('a conflict does not take away that money may still arrive: an unpaid payment with a contradiction has no upper limit', async () => {
  const position = await compute(ev({ paymentIntent: pi({ status: 'requires_payment_method', amount_received: 0 }), charge: charge({ amount_captured: 0, currency: 'usd' }) }))
  assert.deepEqual(allCodes(position), ['conflict:currency_mismatch', 'uncertainty:payment_open'])
  bounds(position, 0, null)
})

// ---- movements of a refund ----------------------------------------------------------------------------------------------------------------------------------------------------
test('the money of a refund left the account: a debit that is POSITIVE is a contradiction, not a refund', async () => {
  const position = await compute(withRefunds([refund({ balance_transaction: refundMovement({ amount: 20, net: 20 }) })], 0))
  assert.deepEqual(allCodes(position), ['conflict:balance_transaction_inconsistent'])
  assert.equal(position.refunds.items[0].outcome, 'excluded')
  bounds(position, 0, 100)
})

test('the fee of the reversal of a failed refund is a fee too: counted with the fee of its debit, never in the capital', async () => {
  const position = await compute(withRefunds([failedRefund({
    balance_transaction: refundMovement({ fee: 4, net: -24 }),
    failure_balance_transaction: reversalMovement({ fee: 9, net: 11 }),
  })], 0))
  assert.deepEqual(allCodes(position), [])
  assert.deepEqual(position.fees, { disputeCents: 0, refundCents: 13, totalCents: 13, complete: true })
  assert.equal(position.retainedCents, 100)
})

// ---- the aggregate against the refunds listed, at the edges ---------------------------------------------------------------------------------------------------------
const AGGREGATE_EDGES: Array<{ name: string; refunds: unknown[]; reported: number; codes: string[] }> = [
  { name: 'exactly what the succeeded refund explains', refunds: [refund({ amount: 20 })], reported: 20, codes: [] },
  { name: 'one cent more than the refunds explain', refunds: [refund({ amount: 20 })], reported: 21, codes: ['uncertainty:refunded_amount_unexplained'] },
  { name: 'one cent less than the succeeded refund', refunds: [refund({ amount: 20 })], reported: 19, codes: ['uncertainty:refunded_amount_lagging'] },
  { name: 'a pending refund the charge counts: exactly the succeeded plus the pending', refunds: [refund({ id: 're_a', amount: 20 }), refund({ id: 're_b', amount: 5, status: 'pending' })], reported: 25, codes: ['uncertainty:refund_in_flight'] },
  { name: 'a pending refund the charge counts: one cent more than all explain', refunds: [refund({ id: 're_a', amount: 20 }), refund({ id: 're_b', amount: 5, status: 'pending' })], reported: 26, codes: ['uncertainty:refund_in_flight', 'uncertainty:refunded_amount_unexplained'] },
  { name: 'a pending refund the charge does not count: exactly the succeeded', refunds: [refund({ id: 're_a', amount: 20 }), refund({ id: 're_b', amount: 5, status: 'pending' })], reported: 20, codes: ['uncertainty:refund_in_flight'] },
  { name: 'a pending refund: one cent less than the succeeded', refunds: [refund({ id: 're_a', amount: 20 }), refund({ id: 're_b', amount: 5, status: 'pending' })], reported: 19, codes: ['uncertainty:refund_in_flight', 'uncertainty:refunded_amount_lagging'] },
  { name: 'nothing listed and nothing reported', refunds: [], reported: 0, codes: [] },
  { name: 'nothing listed and one cent reported', refunds: [], reported: 1, codes: ['uncertainty:refunded_amount_unexplained'] },
]
for (const scenario of AGGREGATE_EDGES) {
  test(`aggregate against the refunds listed, at the edge - ${scenario.name}`, async () => {
    const position = await compute(withRefunds(scenario.refunds, scenario.reported))
    assert.deepEqual(allCodes(position), scenario.codes)
  })
}

test('an incomplete list is not compared with the aggregate: what is missing from the list is already said, and it explains the difference', async () => {
  const position = await compute(ev({ refunds: list([refund({ amount: 20 })], true), charge: charge({ amount_refunded: 50 }) }))
  assert.deepEqual(allCodes(position), ['uncertainty:refunds_incomplete'])
  bounds(position, 0, 80)
})

test('with the total refunded unknown, the refunds that ARE shown still count at best: the position can only be lower than the collected', async () => {
  for (const evidence of [
    ev({ charge: charge({ amount_refunded: undefined }), refunds: list([refund({ amount: 20 })]) }),
    ev({ charge: null, refunds: list([refund({ amount: 20 })]) }),
  ]) {
    const position = await compute(evidence)
    bounds(position, 0, 80)
    assert.equal(position.refunds.reportedByChargeCents, null)
    // the refund that is listed is not "lagging" or "unexplained" against a total nobody read: only the missing total is said
    assert.ok(allCodes(position).includes('uncertainty:refund_total_not_read'))
    assert.ok(!allCodes(position).includes('uncertainty:refunded_amount_lagging') && !allCodes(position).includes('uncertainty:refunded_amount_unexplained'), allCodes(position).join(', '))
  }
})

test('more refunded than collected is reported only for money that really left: a pending refund of 1.50 on a payment of 1.00 is not (yet) over-recovery', async () => {
  const position = await compute(withRefunds([refund({ status: 'pending', amount: 150 })], 150))
  assert.deepEqual(allCodes(position), ['uncertainty:refund_in_flight'])
  assert.equal(position.overRecoveredCents, 0)
  bounds(position, 0, 100)
})

test('the flag "disputed" with no dispute listed is not a contradiction when the list itself is incomplete: that is what is said', async () => {
  const position = await compute(ev({ charge: charge({ disputed: true }), disputes: list([], true) }))
  assert.deepEqual(allCodes(position), ['uncertainty:disputes_incomplete'])
  bounds(position, 0, 100)
})

// ---- fees: complete only when every movement that could carry one was read ----------------------------------------------------------------------------------------
const FEES_COMPLETE_CASES: Array<[string, () => unknown, boolean]> = [
  ['nothing refunded, nothing disputed', () => ev(), true],
  ['a succeeded refund with its movement', () => withRefunds([refund({ amount: 20 })], 20), true],
  ['a succeeded refund whose movement is only an id', () => withRefunds([refund({ amount: 20, balance_transaction: 'txn_re_1' })], 20), false],
  ['a succeeded refund with no movement', () => withRefunds([refund({ amount: 20, balance_transaction: null })], 20), false],
  ['a succeeded refund whose movement shows no fee', () => withRefunds([refund({ amount: 20, balance_transaction: refundMovement({ fee: undefined, net: undefined }) })], 20), false],
  ['a pending refund (no movement yet)', () => withRefunds([refund({ status: 'pending' })], 20), false],
  ['a failed refund with its two movements', () => withRefunds([failedRefund()], 0), true],
  ['a failed refund with the debit and no reversal', () => withRefunds([failedRefund({ failure_balance_transaction: null })], 0), false],
  ['a failed refund that moved nothing', () => withRefunds([failedRefund({ balance_transaction: null, failure_balance_transaction: null })], 0), true],
  ['a failed refund whose movements are ids', () => withRefunds([failedRefund({ balance_transaction: 'txn_x', failure_balance_transaction: 'txn_y' })], 0), false],
  ['a refund in a status nobody knows', () => withRefunds([refund({ status: 'zzz' })], 20), false],
  ['a refund that was set aside', () => withRefunds([refund({ payment_intent: 'pi_other' })], 0), false],
  ['a refund whose movement contradicts it', () => withRefunds([refund({ balance_transaction: refundMovement({ amount: -15, net: -15 }) })], 0), false],
  ['a refund described in two ways', () => withRefunds([refund({ amount: 20 }), refund({ amount: 30 })], 0), false],
  ['a succeeded refund that has a failure movement', () => withRefunds([refund({ failure_balance_transaction: reversalMovement() })], 0), false],
  ['a failed refund with a reversal and no debit', () => withRefunds([failedRefund({ balance_transaction: null })], 0), false],
  ['a dispute described in two ways', () => withDisputes([dispute({ status: 'lost' }), dispute({ status: 'won' })]), false],
  ['a dispute of an amount of zero', () => withDisputes([dispute({ amount: 0 })]), false],
  ['the refunds were not read', () => ev({ refunds: null }), false],
  ['the refunds are not complete', () => ev({ refunds: list([], true) }), false],
  ['a lost dispute with its withdrawal', () => withDisputes([dispute()]), true],
  ['a won dispute with its two movements', () => withDisputes([dispute({ status: 'won', balance_transactions: [withdrawal(), reinstatement()] })]), true],
  ['a lost dispute with no movement', () => withDisputes([dispute({ balance_transactions: [] })]), false],
  ['a dispute whose movements were not read', () => withDisputes([dispute({ balance_transactions: null })]), false],
  ['a dispute whose movements are ids', () => withDisputes([dispute({ balance_transactions: ['txn_a'] })]), false],
  ['a dispute movement that shows no fee', () => withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000, { fee: undefined, net: undefined })] })]), false],
  ['a dispute that was set aside', () => withDisputes([dispute({ payment_intent: 'pi_other' })]), false],
  ['the disputes were not read', () => ev({ disputes: null }), false],
  ['the disputes are not complete', () => ev({ disputes: list([], true) }), false],
]
for (const [name, build, complete] of FEES_COMPLETE_CASES) {
  test(`the fees are complete only when every movement that could carry one was read - ${name}`, async () => {
    assert.equal((await compute(build())).fees.complete, complete)
  })
}

// ---- the same object described twice: a difference in ANY field the model reads is a contradiction ---------------------------------------------------------------
const REFUND_FIELD_CHANGES: Array<[string, Record<string, unknown>]> = [
  ['the amount', { amount: 21 }],
  ['the currency', { currency: 'usd' }],
  ['the status', { status: 'pending' }],
  ['the payment', { payment_intent: 'pi_other' }],
  ['the charge', { charge: 'ch_other' }],
  ['the movement of the refund', { balance_transaction: refundMovement({ fee: 7, net: -27 }) }],
  ['the failure movement', { failure_balance_transaction: reversalMovement() }],
]
for (const [name, change] of REFUND_FIELD_CHANGES) {
  test(`a refund described twice, differing only in ${name}, is a contradiction`, async () => {
    const base = refund({ amount: 20, balance_transaction: 'txn_re_1' })
    const position = await compute(withRefunds([base, { ...base, ...change }], 0))
    assert.ok(codesOf(position, 'conflict').includes('conflicting_duplicate'), allCodes(position).join(', '))
    assert.equal(position.refunds.items[0].outcome, 'excluded')
    bounds(position, 0, 100)
  })
}

const DISPUTE_FIELD_CHANGES: Array<[string, Record<string, unknown>]> = [
  ['the amount', { amount: 101 }],
  ['the currency', { currency: 'usd' }],
  ['the status', { status: 'won' }],
  ['the payment', { payment_intent: 'pi_other' }],
  ['the charge', { charge: 'ch_other' }],
  ['the movements', { balance_transactions: ['txn_dp_w', 'txn_dp_x'] }],
  ['the movements being read or not', { balance_transactions: null }],
]
for (const [name, change] of DISPUTE_FIELD_CHANGES) {
  test(`a dispute described twice, differing only in ${name}, is a contradiction`, async () => {
    const base = dispute({ balance_transactions: ['txn_dp_w'] })
    const position = await compute(withDisputes([base, { ...base, ...change }]))
    assert.ok(codesOf(position, 'conflict').includes('conflicting_duplicate'), allCodes(position).join(', '))
    assert.equal(position.disputes.items[0].phase, 'excluded')
    bounds(position, 0, 100)
  })
}

test('a dispute described twice with the same movements in another order is the same dispute', async () => {
  const feeOnly = withdrawal(0, 1, { id: 'txn_dp_b', amount: 0, net: -1 })
  const first = dispute({ balance_transactions: [withdrawal(100, 0, { id: 'txn_dp_a' }), feeOnly] })
  const second = dispute({ balance_transactions: [feeOnly, withdrawal(100, 0, { id: 'txn_dp_a' })] })
  const position = await compute(withDisputes([first, second]))
  assert.deepEqual(allCodes(position), ['note:duplicate_removed'])
  assert.equal(position.disputes.items.length, 1)
  assert.equal(position.retainedCents, 0)
})

const MOVEMENT_FIELD_CHANGES: Array<[string, Record<string, unknown>]> = [
  ['the amount', { amount: -99 }],
  ['the fee', { fee: 1999 }],
  ['the net', { net: -2101 }],
  ['the category', { reporting_category: 'dispute_reversal' }],
  ['the currency', { currency: 'usd' }],
  ['the source', { source: 'dp_other' }],
]
for (const [name, change] of MOVEMENT_FIELD_CHANGES) {
  test(`a movement listed twice, differing only in ${name}, is a contradiction, and the dispute is set aside`, async () => {
    const position = await compute(withDisputes([dispute({ balance_transactions: [withdrawal(100, 2000), { ...withdrawal(100, 2000), ...change }] })]))
    assert.ok(codesOf(position, 'conflict').includes('conflicting_duplicate'), allCodes(position).join(', '))
    assert.equal(position.disputes.items[0].phase, 'excluded')
    bounds(position, 0, 100)
  })
}

// ---- the order of the findings --------------------------------------------------------------------------------------------------------------------------------------------------
test('findings of the same code for several objects come in the order of their reference, whatever order they were found in', async () => {
  const position = await compute(ev({
    refunds: list([refund({ id: 're_z', amount: 20 }), refund({ id: 're_z', amount: 20 })]),
    charge: charge({ amount_refunded: 20 }),
    requestedRefunds: [{ id: 're_a', amount: 5 }, { id: 're_a', amount: 5 }],
  }))
  assert.deepEqual(position.findings.map((entry) => `${entry.code}:${entry.ref}`), ['refund_requested:re_a', 'duplicate_removed:re_a', 'duplicate_removed:re_z'])
  assertOrdered(position, 'two references')
  const pending = await compute(withRefunds([refund({ id: 're_b', status: 'pending', amount: 5 }), refund({ id: 're_a', status: 'pending', amount: 7 })], 12))
  assert.deepEqual(pending.findings.map((entry) => `${entry.code}:${entry.ref}`), ['refund_in_flight:re_a', 'refund_in_flight:re_b'], 'one finding per object, not one per code')
})

// ---- the interval, computed by plain arithmetic from the reading of each uncertain part ----------------------------------------------------------------------------
// Every refund and every dispute of the world has a SHAPE whose worst and best readings are known; the expected interval is [collected - worst, collected - best], and the findings are the
// ones the shapes say. Nothing here shares code with the model.
const REFUND_SHAPES = ['succeeded', 'pending', 'failed_proven', 'failed_unproven', 'unknown_status'] as const
const DISPUTE_SHAPES = ['lost_full', 'lost_partial', 'lost_none', 'lost_unread', 'lost_ids', 'won_full', 'won_partial', 'won_unreturned', 'won_nothing', 'open_with_withdrawal', 'open_nothing', 'unmodeled'] as const
type ShapedWorld = { evidence: Record<string, unknown>; collected: number; confirmed: number; refundWorst: number; refundBest: number; goneWorst: number; goneBest: number; disputeFees: number; codes: Set<string> }
function shapedWorld(random: Random): ShapedWorld {
  const collected = between(random, 4_000, 20_000)
  const world: ShapedWorld = { evidence: {}, collected, confirmed: 0, refundWorst: 0, refundBest: 0, goneWorst: 0, goneBest: 0, disputeFees: 0, codes: new Set() }
  const refunds: unknown[] = []
  let counted = 0
  for (let index = 0, count = between(random, 0, 4); index < count; index++) {
    const id = `re_${index}`
    const amount = between(random, 1, 3_000)
    const shape = pick(random, REFUND_SHAPES)
    if (shape === 'succeeded') {
      refunds.push(refund({ id, amount }))
      world.confirmed += amount; world.refundBest += amount; world.refundWorst += amount
    } else if (shape === 'pending') {
      refunds.push(refund({ id, amount, status: 'pending' }))
      world.refundWorst += amount; world.codes.add('uncertainty:refund_in_flight')
      if (random() < 0.5) counted += amount
    } else if (shape === 'failed_proven') refunds.push(failedRefund({ id, amount }))
    else if (shape === 'failed_unproven') {
      refunds.push(failedRefund({ id, amount, failure_balance_transaction: null }))
      world.refundWorst += amount; world.codes.add('uncertainty:refund_reversal_unproven')
    } else {
      refunds.push(refund({ id, amount, status: 'zzz' }))
      world.refundWorst += amount; world.codes.add('uncertainty:refund_state_unknown')
      if (random() < 0.5) counted += amount
    }
  }
  const disputes: unknown[] = []
  for (let index = 0, count = between(random, 0, 2); index < count; index++) {
    const id = `dp_${index}`
    const amount = between(random, 2, 3_000)
    const fee = between(random, 0, 4_000)
    const out = (value: number) => withdrawal(value, fee, { id: `txn_w${index}`, source: id })
    const back = (value: number) => reinstatement(value, 0, { id: `txn_r${index}`, source: id })
    const part = between(random, 1, amount - 1)
    const shape = pick(random, DISPUTE_SHAPES)
    const make = (status: string, movements: unknown[] | null) => disputes.push(dispute({ id, amount, status, balance_transactions: movements }))
    if (shape === 'lost_full') { make('lost', [out(amount)]); world.goneWorst += amount; world.goneBest += amount; world.disputeFees += fee }
    else if (shape === 'lost_partial') { make('lost', [out(part)]); world.goneWorst += amount; world.goneBest += part; world.disputeFees += fee; world.codes.add('uncertainty:dispute_withdrawal_incomplete') }
    else if (shape === 'lost_none') { make('lost', []); world.goneWorst += amount; world.codes.add('uncertainty:dispute_lost_without_withdrawal') }
    else if (shape === 'lost_unread') { make('lost', null); world.goneWorst += amount; world.codes.add('uncertainty:dispute_movements_not_read') }
    else if (shape === 'lost_ids') { make('lost', [`txn_x${index}`]); world.goneWorst += amount; world.codes.add('uncertainty:dispute_movements_unreadable') }
    else if (shape === 'won_full') { make('won', [out(amount), back(amount)]); world.disputeFees += fee }
    else if (shape === 'won_partial') { make('won', [out(amount), back(part)]); world.goneWorst += amount - part; world.disputeFees += fee; world.codes.add('uncertainty:dispute_won_funds_not_returned') }
    else if (shape === 'won_unreturned') { make('won', [out(amount)]); world.goneWorst += amount; world.disputeFees += fee; world.codes.add('uncertainty:dispute_won_funds_not_returned') }
    else if (shape === 'won_nothing') { make('won', []); world.goneWorst += amount; world.codes.add('uncertainty:dispute_won_funds_not_shown') }
    else if (shape === 'open_with_withdrawal') { make('needs_response', [out(amount)]); world.goneWorst += amount; world.disputeFees += fee; world.codes.add('uncertainty:dispute_open') }
    else if (shape === 'open_nothing') { make('under_review', []); world.goneWorst += amount; world.codes.add('uncertainty:dispute_open') }
    else { make(pick(random, ['warning_closed', 'prevented', 'zzz']), []); world.goneWorst += amount; world.codes.add('uncertainty:dispute_status_not_modeled') }
  }
  world.evidence = ev({
    paymentIntent: pi({ amount: collected, amount_received: collected }),
    // the charge counts the succeeded refunds, and perhaps the ones that are not decided yet (it did, in Test Mode)
    charge: charge({ amount: collected, amount_captured: collected, amount_refunded: world.confirmed + counted, disputed: disputes.length > 0 }),
    refunds: list(refunds),
    disputes: list(disputes),
  })
  return world
}
test('property (400 worlds): with uncertain parts the interval, the findings and the fees are exactly what the reading of each part leaves - computed here by plain arithmetic', async () => {
  for (let seed = 1; seed <= 400; seed++) {
    const world = shapedWorld(mulberry32(seed * 104_729))
    const position = await compute(world.evidence)
    const label = `seed ${seed}`
    const over = Math.max(0, world.refundBest + world.goneBest - world.collected)
    const expected = [...world.codes, ...(over > 0 ? ['anomaly:over_recovered'] : [])].sort()
    assert.deepEqual([...new Set(allCodes(position))], expected, label)
    bounds(position, Math.max(0, world.collected - world.refundWorst - world.goneWorst), Math.max(0, world.collected - world.refundBest - world.goneBest), label)
    assert.equal(position.overRecoveredCents, over, label)
    assert.equal(position.certainty, expected.some((code) => code.startsWith('uncertainty:')) ? 'uncertain' : 'proven', label)
    assert.equal(position.refunds.confirmedCents, world.confirmed, label)
    assert.equal(position.disputes.fundsGoneLowerCents, world.goneWorst, label)
    assert.equal(position.disputes.fundsGoneUpperCents, world.goneBest, label)
    assert.equal(position.fees.disputeCents, world.disputeFees, label)
    assert.equal(position.final, position.certainty === 'proven' && world.confirmed === 0, label)
    await assertWellFormed(position, label)
  }
})

// ---- contradictions injected into worlds that were proven: whatever the world, the result is the widest interval and the contradiction is named -----------------------
type Injected = {
  paymentIntent: Record<string, unknown>
  charge: Record<string, unknown>
  refunds: { data: Array<Record<string, unknown>> }
  disputes: { data: Array<Record<string, unknown>> }
  requestedRefunds?: Array<Record<string, unknown>>
}
const DEFECTS: Array<{ name: string; code: string; apply: (draft: Injected) => boolean }> = [
  { name: 'a refund of another payment is listed', code: 'foreign_evidence', apply: (draft) => { draft.refunds.data.push(refund({ id: 're_foreign', payment_intent: 'pi_other', amount: 5 })); return true } },
  { name: 'a refund that names nothing is listed', code: 'unattributable_evidence', apply: (draft) => { draft.refunds.data.push(refund({ id: 're_nameless', payment_intent: null, charge: null, amount: 5 })); return true } },
  { name: 'a dispute of another payment is listed', code: 'foreign_evidence', apply: (draft) => { draft.disputes.data.push(dispute({ id: 'dp_foreign', payment_intent: 'pi_other', balance_transactions: [] })); return true } },
  { name: 'the first refund is in another currency', code: 'currency_mismatch', apply: (draft) => { const target = draft.refunds.data[0]; if (!target) return false; target.currency = 'usd'; return true } },
  { name: 'the first refund has an amount of zero', code: 'invalid_amount', apply: (draft) => { const target = draft.refunds.data[0]; if (!target) return false; target.amount = 0; return true } },
  { name: 'the first refund has no id', code: 'invalid_identifier', apply: (draft) => { const target = draft.refunds.data[0]; if (!target) return false; delete target.id; return true } },
  { name: 'the first refund is listed again with another amount', code: 'conflicting_duplicate', apply: (draft) => { const target = draft.refunds.data[0]; if (!target) return false; draft.refunds.data.push({ ...target, amount: Number(target.amount) + 1 }); return true } },
  { name: 'the debit of the first succeeded refund is positive', code: 'balance_transaction_inconsistent', apply: (draft) => { const target = draft.refunds.data.find((entry) => entry.status === 'succeeded'); if (!target) return false; const movement = target.balance_transaction as Record<string, number>; movement.amount = -movement.amount; movement.net = -movement.net; return true } },
  { name: 'the net of the first movement does not match', code: 'balance_transaction_inconsistent', apply: (draft) => { const target = draft.disputes.data[0]; if (!target) return false; const movement = (target.balance_transactions as Array<Record<string, number>>)[0]; movement.net += 1; return true } },
  { name: 'the first dispute has a movement of a category nobody knows', code: 'unrecognized_movement', apply: (draft) => { const target = draft.disputes.data[0]; if (!target) return false; (target.balance_transactions as Array<Record<string, unknown>>)[0].reporting_category = 'other_adjustment'; return true } },
  { name: 'the first dispute is for less than was withdrawn', code: 'dispute_amounts_inconsistent', apply: (draft) => { const target = draft.disputes.data[0]; if (!target) return false; const withdrawn = -(target.balance_transactions as Array<Record<string, number>>)[0].amount; if (withdrawn < 2) return false; target.amount = withdrawn - 1; return true } },
  { name: 'the charge belongs to another payment', code: 'charge_mismatch', apply: (draft) => { draft.charge.payment_intent = 'pi_other'; return true } },
  { name: 'the charge captured another amount', code: 'charge_mismatch', apply: (draft) => { draft.charge.amount_captured = Number(draft.charge.amount_captured) - 1; return true } },
  { name: 'the charge says it is not disputed while a dispute is listed', code: 'dispute_flag_mismatch', apply: (draft) => { if (draft.disputes.data.length === 0) return false; draft.charge.disputed = false; return true } },
  { name: 'the payment is in another currency than the charge', code: 'currency_mismatch', apply: (draft) => { draft.paymentIntent.currency = 'usd'; return true } },
  { name: 'an element of the list of refunds is not an object', code: 'invalid_evidence', apply: (draft) => { draft.refunds.data.push(5 as unknown as Record<string, unknown>); return true } },
  { name: 'the id of the payment is malformed', code: 'invalid_identifier', apply: (draft) => { draft.paymentIntent.id = 'a b'; return true } },
  { name: 'the total refunded by the charge is negative', code: 'invalid_amount', apply: (draft) => { draft.charge.amount_refunded = -1; return true } },
  { name: 'the amount received is negative', code: 'invalid_amount', apply: (draft) => { draft.paymentIntent.amount_received = -1; return true } },
  // P1-bis (A): an id names ONE refund
  { name: 'a request names the first listed refund with an amount that is a cent more', code: 'conflicting_duplicate', apply: (draft) => { const target = draft.refunds.data[0]; if (!target) return false; draft.requestedRefunds = [{ id: target.id, amount: Number(target.amount) + 1 }]; return true } },
  { name: 'a request names the first listed refund with an amount that is a cent less', code: 'conflicting_duplicate', apply: (draft) => { const target = draft.refunds.data[0]; if (!target || Number(target.amount) < 2) return false; draft.requestedRefunds = [{ id: target.id, amount: Number(target.amount) - 1 }]; return true } },
  { name: 'the same refund is requested twice with two amounts', code: 'conflicting_duplicate', apply: (draft) => { draft.requestedRefunds = [{ id: 're_new', amount: 5 }, { id: 're_new', amount: 6 }]; return true } },
  { name: 'a request names the first listed refund in another currency', code: 'currency_mismatch', apply: (draft) => { const target = draft.refunds.data[0]; if (!target) return false; draft.requestedRefunds = [{ id: target.id, amount: target.amount, currency: 'usd' }]; return true } },
]
for (const defect of DEFECTS) {
  test(`property (300 worlds): a contradiction injected into a proven position is named and leaves the widest interval - ${defect.name}`, async () => {
    let applied = 0
    for (let seed = 1; seed <= 300; seed++) {
      const world = provenWorld(mulberry32(seed))
      const draft = deepClone(world.evidence) as unknown as Injected
      if (!defect.apply(draft)) continue
      applied++
      const position = await compute(draft)
      const label = `seed ${seed}`
      assert.ok(codesOf(position, 'conflict').includes(defect.code), `${label} ${allCodes(position).join(', ')}`)
      assert.equal(position.certainty, 'uncertain', label)
      assert.equal(position.retainedCents, null, label)
      assert.equal(position.final, false, label)
      await assertWellFormed(position, label)
    }
    assert.ok(applied >= 50, `the defect applied to only ${applied} worlds`)
  })
}

// (title changed by P1-bis, defect B: "nothing else" stopped being true - the question "is nothing held?" also reads whether the position is FINAL; its assertions are unchanged, and the
// positions written here by spreading a collected payment are final)
test('the two questions read the bounds and the certainty of a position (and, for "nothing is held", whether it is final) - tried on positions written by hand', async () => {
  const { retainedAtLeast, retainedIsZero } = await load()
  const base = await compute(ev())
  const made = (lower: number, upper: number | null, certainty: 'proven' | 'uncertain'): FundsPosition => ({ ...base, retainedLowerCents: lower, retainedUpperCents: upper, certainty })
  // "nothing is held": only a proven position whose best reading is zero
  assert.equal(retainedIsZero(made(0, 0, 'proven')), 'yes')
  assert.equal(retainedIsZero(made(0, 0, 'uncertain')), 'unknown')
  assert.equal(retainedIsZero(made(0, 50, 'proven')), 'unknown')
  assert.equal(retainedIsZero(made(0, null, 'proven')), 'unknown')
  assert.equal(retainedIsZero(made(5, 50, 'uncertain')), 'no')
  assert.equal(retainedIsZero(made(5, 50, 'proven')), 'no')
  // "at least": yes from the worst reading, no from the best one, otherwise unknown
  assert.equal(retainedAtLeast(made(5, 50, 'uncertain'), 0), 'yes')
  assert.equal(retainedAtLeast(made(5, 50, 'uncertain'), 5), 'yes')
  assert.equal(retainedAtLeast(made(5, 50, 'uncertain'), 6), 'unknown')
  assert.equal(retainedAtLeast(made(5, 50, 'uncertain'), 50), 'unknown')
  assert.equal(retainedAtLeast(made(5, 50, 'uncertain'), 51), 'no')
  assert.equal(retainedAtLeast(made(0, null, 'uncertain'), 1), 'unknown')
  assert.equal(retainedAtLeast(made(0, null, 'uncertain'), Number.MAX_SAFE_INTEGER), 'unknown')
  assert.equal(retainedAtLeast(made(0, 0, 'proven'), 1), 'no')
  assert.equal(retainedAtLeast(made(0, 0, 'proven'), 0), 'yes')
})

test('when the charge and the payment disagree about the latest charge the position is a contradiction - and the refunds are judged against the charge that was READ', async () => {
  const position = await compute(ev({
    paymentIntent: pi({ latest_charge: 'ch_a' }),
    charge: charge({ id: 'ch_b', amount_refunded: 20 }),
    refunds: list([refund({ charge: 'ch_b' })]),
  }))
  assert.deepEqual(allCodes(position), ['conflict:charge_mismatch'])
  assert.equal(position.refunds.items[0].outcome, 'effective')
  bounds(position, 0, 100)
})

test('the same refund described once with ids and once with expanded objects is the same refund, not a contradiction', async () => {
  const expanded = refund({
    payment_intent: { id: PI }, charge: { id: CH },
    balance_transaction: refundMovement({ source: { id: 're_1' } }),
  })
  const position = await compute(withRefunds([refund(), expanded], 20))
  assert.deepEqual(allCodes(position), ['note:duplicate_removed'])
  assert.equal(position.retainedCents, 80)
  const dispute2 = dispute({ payment_intent: { id: PI }, charge: { id: CH }, balance_transactions: [withdrawal(100, 2000, { source: { id: 'dp_1' } })] })
  const again = await compute(withDisputes([dispute(), dispute2]))
  assert.deepEqual(allCodes(again), ['note:duplicate_removed'])
  assert.equal(again.retainedCents, 0)
})

// ---- the edges of the rules that look like numbers ----------------------------------------------------------------------------------------------------------------------
test('an identifier may be 255 characters long, not 256; a status is echoed up to 40 letters, not 41', async () => {
  const accepted = await compute(withRefunds([refund({ id: `re_${'x'.repeat(252)}`, balance_transaction: null })], 20))
  assert.equal(accepted.refunds.items[0].id.length, 255)
  assert.deepEqual(allCodes(accepted), [])
  const refused = await compute(withRefunds([refund({ id: `re_${'x'.repeat(253)}`, balance_transaction: null })], 0))
  assert.deepEqual(allCodes(refused), ['conflict:invalid_identifier'])
  const longest = await compute(withRefunds([refund({ status: 'a'.repeat(40), balance_transaction: null })], 20))
  assert.equal(longest.refunds.items[0].status, 'a'.repeat(40))
  const tooLong = await compute(withRefunds([refund({ status: 'a'.repeat(41), balance_transaction: null })], 20))
  assert.equal(tooLong.refunds.items[0].status, null)
  assert.deepEqual(allCodes(tooLong), ['uncertainty:refund_state_unknown'])
})

test('a movement of a dispute whose amount is exactly zero is a fee-only movement for the withdrawal AND for the reinstatement; a won dispute that is reinstated in full is proven', async () => {
  const position = await compute(withDisputes([dispute({
    status: 'won', balance_transactions: [withdrawal(100, 2000), reinstatement(100, 0), reinstatement(0, 0, { id: 'txn_dp_zero', amount: 0, net: 0 })],
  })]))
  assert.deepEqual(allCodes(position), [])
  assert.equal(position.retainedCents, 100)
  assert.equal(position.disputes.reinstatedCents, 100)
})

test('the total refunded may be zero (a charge that was never refunded), and the zero is a figure, not a missing one', async () => {
  const position = await compute(ev({ charge: charge({ amount_refunded: 0 }) }))
  assert.deepEqual(allCodes(position), [])
  assert.equal(position.refunds.reportedByChargeCents, 0)
})

// =====================================================================================================================================================================
// 17. P1-bis - written FIRST (red) after an independent audit of ae71c32 (docs/VERIFICA-4.6.md S6a.20)
//   A. An id names ONE refund. A request that says another amount than the refund Stripe lists under that id - or than another request with that id - is a contradiction. The model used
//      to skip such a request (when Stripe listed the id) or to keep the first one (when it did not) without a look at the amount: the answer depended on the order of the list, and
//      "at least X is held" could be 'yes' on a figure that one of the two descriptions denied.
//   B. "Is nothing held?" answers 'yes' only for a zero that is also FINAL. A proven zero that rests on a refund that succeeded is zero in the SNAPSHOT: AR-2 B showed that such a refund can
//      still fail, and then the whole capital is back. A zero that can be relied on for a decision that cannot be undone is a different thing, and only that one is a 'yes'.
// =====================================================================================================================================================================
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))
}
const asked = (id: string, amount: number, over: Record<string, unknown> = {}) => ({ id, amount, ...over })

// ---- A. one id, one refund: two amounts are a contradiction ----------------------------------------------------------------------------------------------------------------
type SameIdScenario = { name: string; evidence: () => unknown; others: string[] }
const SAME_ID_CONTRADICTIONS: SameIdScenario[] = [
  { name: 'Stripe lists 20 and the application asked for 80', evidence: () => withRefunds([refund({ id: 're_1', amount: 20 })], 20, { requestedRefunds: [asked('re_1', 80)] }), others: [] },
  { name: 'Stripe lists 80 and the application asked for 20', evidence: () => withRefunds([refund({ id: 're_1', amount: 80 })], 80, { requestedRefunds: [asked('re_1', 20)] }), others: [] },
  { name: 'Stripe lists 20 and the application asked for 19, a cent less', evidence: () => withRefunds([refund({ id: 're_1', amount: 20 })], 20, { requestedRefunds: [asked('re_1', 19)] }), others: [] },
  { name: 'Stripe lists 20 and the application asked for 21, a cent more', evidence: () => withRefunds([refund({ id: 're_1', amount: 20 })], 20, { requestedRefunds: [asked('re_1', 21)] }), others: [] },
  { name: 'two requests with the same id, 20 and then 80, and Stripe lists nothing', evidence: () => ev({ requestedRefunds: [asked('re_1', 20), asked('re_1', 80)] }), others: [] },
  { name: 'the same two requests in the other order, 80 and then 20', evidence: () => ev({ requestedRefunds: [asked('re_1', 80), asked('re_1', 20)] }), others: [] },
  { name: 'three requests with the same id, 20, 20 and 80', evidence: () => ev({ requestedRefunds: [asked('re_1', 20), asked('re_1', 20), asked('re_1', 80)] }), others: [] },
  { name: 'Stripe lists 20 and the application asked twice, for 20 and for 80', evidence: () => withRefunds([refund({ id: 're_1', amount: 20 })], 20, { requestedRefunds: [asked('re_1', 20), asked('re_1', 80)] }), others: [] },
  { name: 'Stripe lists a PENDING refund of 20 and the application asked for 80', evidence: () => withRefunds([refund({ id: 're_1', amount: 20, status: 'pending' })], 20, { requestedRefunds: [asked('re_1', 80)] }), others: ['uncertainty:refund_in_flight'] },
  { name: 'Stripe lists a FAILED refund of 20 (the money is back) and the application asked for 80', evidence: () => withRefunds([failedRefund({ id: 're_1', amount: 20 })], 0, { requestedRefunds: [asked('re_1', 80)] }), others: [] },
  { name: 'Stripe lists a refund in a status nobody knows (20) and the application asked for 80', evidence: () => withRefunds([refund({ id: 're_1', amount: 20, status: 'zzz' })], 20, { requestedRefunds: [asked('re_1', 80)] }), others: ['uncertainty:refund_state_unknown'] },
]
for (const scenario of SAME_ID_CONTRADICTIONS) {
  test(`P1-bis A - one id, two amounts: a contradiction, never a quiet reconciliation - ${scenario.name}`, async () => {
    const { retainedAtLeast, retainedIsZero } = await load()
    const position = await compute(scenario.evidence())
    assert.deepEqual(codesOf(position, 'conflict'), ['conflicting_duplicate'], allCodes(position).join(', '))
    assert.equal(finding(position, 'conflicting_duplicate')?.ref, 're_1')
    assert.deepEqual(allCodes(position).filter((code) => !code.startsWith('conflict:')), scenario.others)
    assert.equal(position.certainty, 'uncertain')
    assert.equal(position.retainedCents, null)
    assert.equal(position.final, false)
    assert.equal(position.refunds.requestedCents, 0, 'a request that contradicts what Stripe lists, or another request, is not counted as if it were agreed')
    bounds(position, 0, 100)
    for (const wanted of [1, 19, 20, 21, 80, 100]) assert.equal(retainedAtLeast(position, wanted), 'unknown', `at least ${wanted}: a contradiction holds up no figure`)
    assert.equal(retainedAtLeast(position, 101), 'no')
    assert.equal(retainedIsZero(position), 'unknown')
    await assertWellFormed(position, scenario.name)
  })
}

test('P1-bis A - reproduction: Stripe lists re_1 for 20 and the application asked for 80 under the same id - "at least 80 is held" must not be answered yes, on a figure that one of the two denies', async () => {
  const { retainedAtLeast } = await load()
  const position = await compute(withRefunds([refund({ id: 're_1', amount: 20 })], 20, { requestedRefunds: [asked('re_1', 80)] }))
  // before the fix the request was skipped because Stripe lists its id: proven, 80 held, and "at least 80" was 'yes'
  assert.notEqual(retainedAtLeast(position, 80), 'yes')
  assert.equal(position.certainty, 'uncertain')
  assert.ok(position.retainedLowerCents < 80)
})

test('P1-bis A - reproduction: two requests for the same id, 20 and 80, give the same position in either order - and it is a contradiction, not the first one', async () => {
  const forward = await compute(ev({ requestedRefunds: [asked('re_1', 20), asked('re_1', 80)] }))
  const backward = await compute(ev({ requestedRefunds: [asked('re_1', 80), asked('re_1', 20)] }))
  // before the fix the first request won: 20 in one order, 80 in the other
  assert.deepEqual(forward, backward)
  assert.equal(forward.refunds.requestedCents, 0)
  assert.ok(codesOf(forward, 'conflict').includes('conflicting_duplicate'))
})

test('P1-bis A - the order of the requests changes nothing: every order of the same requests gives the same position', async () => {
  const sets: Array<{ name: string; requests: unknown[]; requested: number; refs: string[] }> = [
    { name: 'two requests, 20 and 80, one id', requests: [asked('re_1', 20), asked('re_1', 80)], requested: 0, refs: ['re_1'] },
    { name: 'three requests, 20, 20 and 80, one id', requests: [asked('re_1', 20), asked('re_1', 20), asked('re_1', 80)], requested: 0, refs: ['re_1'] },
    { name: 'a contradiction among requests that are fine', requests: [{ amount: 7 }, asked('re_1', 20), asked('re_1', 21), asked('re_2', 3)], requested: 10, refs: ['re_1'] },
    { name: 'two ids, each described twice, one of them in two ways', requests: [asked('re_1', 20), asked('re_2', 5), asked('re_1', 20), asked('re_2', 6)], requested: 20, refs: ['re_2'] },
  ]
  for (const set of sets) {
    const base = await compute(ev({ requestedRefunds: set.requests }))
    assert.equal(base.refunds.requestedCents, set.requested, set.name)
    assert.deepEqual(base.findings.filter((entry) => entry.code === 'conflicting_duplicate').map((entry) => entry.ref), set.refs, set.name)
    for (const order of permutations(set.requests)) assert.deepEqual(await compute(ev({ requestedRefunds: order })), base, `${set.name}: ${JSON.stringify(order)}`)
  }
})

// A request that says what Stripe lists is the same refund: counted once, nothing added, nothing changed - whatever the state of the refund Stripe lists
const LISTED_AS: Array<[string, () => Record<string, unknown>, number]> = [
  ['succeeded', () => refund({ id: 're_1', amount: 20 }), 20],
  ['pending', () => refund({ id: 're_1', amount: 20, status: 'pending' }), 20],
  ['requires_action', () => refund({ id: 're_1', amount: 20, status: 'requires_action' }), 20],
  ['failed, with its reversal (the money is back)', () => failedRefund({ id: 're_1', amount: 20 }), 0],
  ['in a status nobody knows', () => refund({ id: 're_1', amount: 20, status: 'zzz' }), 20],
]
const ASKED_AS: Array<[string, unknown[]]> = [
  ['by its id and its amount', [asked('re_1', 20)]],
  ['with the currency in lower case', [asked('re_1', 20, { currency: 'eur' })]],
  ['with the currency in capitals', [asked('re_1', 20, { currency: 'EUR' })]],
  ['twice, identically', [asked('re_1', 20), asked('re_1', 20)]],
  ['twice, once with the currency and once without', [asked('re_1', 20), asked('re_1', 20, { currency: 'eur' })]],
  ['three times, with and without the currency, in capitals too', [asked('re_1', 20, { currency: 'EUR' }), asked('re_1', 20), asked('re_1', 20, { currency: 'eur' })]],
]
for (const [listedName, listed, reported] of LISTED_AS) {
  for (const [askedName, requests] of ASKED_AS) {
    test(`P1-bis A - a request that says what Stripe lists (${listedName}) is the same refund: counted once, nothing added or changed - asked ${askedName}`, async () => {
      const without = await compute(withRefunds([listed()], reported))
      const withRequests = await compute(withRefunds([listed()], reported, { requestedRefunds: requests }))
      assert.deepEqual(withRequests, without)
      assert.equal(withRequests.refunds.requestedCents, 0)
    })
  }
}

test('P1-bis A - identical requests for an id Stripe does not list are ONE request: counted once, with a note - whether the currency is written or not', async () => {
  for (const requests of [
    [asked('re_7', 20), asked('re_7', 20)],
    [asked('re_7', 20), asked('re_7', 20, { currency: 'eur' })],
    [asked('re_7', 20, { currency: 'EUR' }), asked('re_7', 20, { currency: 'eur' }), asked('re_7', 20)],
  ]) {
    const position = await compute(ev({ requestedRefunds: requests }))
    assert.equal(position.refunds.requestedCents, 20, JSON.stringify(requests))
    assert.deepEqual(allCodes(position), ['note:duplicate_removed', 'uncertainty:refund_requested'], JSON.stringify(requests))
    bounds(position, 80, 100)
  }
})

// the currency is part of what a request says; nothing is converted
test('P1-bis A - two requests for one id in two currencies are a contradiction, even when the payment itself has no usable currency (then nothing else can tell them apart)', async () => {
  const position = await compute(ev({ paymentIntent: pi({ currency: 'euro' }), requestedRefunds: [asked('re_1', 20, { currency: 'usd' }), asked('re_1', 20, { currency: 'eur' })] }))
  assert.deepEqual(allCodes(position), ['conflict:conflicting_duplicate', 'conflict:invalid_currency'])
  assert.equal(position.refunds.requestedCents, 0)
  bounds(position, 0, 100)
})

test('P1-bis A - a request in another currency than the payment is a contradiction and is not counted; the same id asked in the right currency still is - nothing is converted', async () => {
  const position = await compute(ev({ requestedRefunds: [asked('re_1', 20, { currency: 'usd' }), asked('re_1', 20, { currency: 'eur' })] }))
  assert.deepEqual(allCodes(position), ['conflict:currency_mismatch', 'uncertainty:refund_requested'])
  assert.equal(position.refunds.requestedCents, 20)
  bounds(position, 0, 100)
})

// when the listed refund was set aside it has already said why: the request adds nothing, and no second contradiction is invented
const SET_ASIDE_LISTED: Array<{ name: string; refunds: unknown[]; reported: number; codes: string[] }> = [
  { name: 'it belongs to another payment', refunds: [refund({ id: 're_1', amount: 20, payment_intent: 'pi_other' })], reported: 20, codes: ['conflict:foreign_evidence', 'uncertainty:refunded_amount_unexplained'] },
  { name: 'it is in another currency', refunds: [refund({ id: 're_1', amount: 20, currency: 'usd' })], reported: 20, codes: ['conflict:currency_mismatch', 'uncertainty:refunded_amount_unexplained'] },
  { name: 'its amount is not valid', refunds: [refund({ id: 're_1', amount: 0 })], reported: 0, codes: ['conflict:invalid_amount'] },
]
for (const scenario of SET_ASIDE_LISTED) {
  test(`P1-bis A - a request for an id that Stripe lists, whose listed refund was set aside (${scenario.name}), adds nothing: that refund has already said why`, async () => {
    const position = await compute(withRefunds(scenario.refunds, scenario.reported, { requestedRefunds: [asked('re_1', 20)] }))
    assert.deepEqual(allCodes(position), scenario.codes)
    assert.equal(position.refunds.requestedCents, 0)
    assert.deepEqual(position, await compute(withRefunds(scenario.refunds, scenario.reported)))
  })
}

// ---- A, properties over generated worlds ----------------------------------------------------------------------------------------------------------------------------------------
// requests that say what a world's refunds say (same id, same amount): the currency written or not, some of them twice, in any order
function mirroredRequests(random: Random, evidence: Record<string, unknown>): Array<Record<string, unknown>> {
  const listed = (evidence.refunds as { data: Array<Record<string, unknown>> }).data
  const requests: Array<Record<string, unknown>> = []
  for (const item of listed) {
    if (random() < 0.4) continue
    const request: Record<string, unknown> = { id: item.id, amount: item.amount }
    if (random() < 0.5) request.currency = random() < 0.5 ? 'eur' : 'EUR'
    requests.push(request)
    if (random() < 0.3) requests.push({ ...request })
  }
  return shuffled(random, requests)
}
const WORLDS: Array<[string, (random: Random) => { evidence: Record<string, unknown> }]> = [
  ['every part shown and consistent', provenWorld],
  ['parts that are uncertain', shapedWorld],
]
for (const [kind, generate] of WORLDS) {
  test(`P1-bis A property (300 worlds, ${kind}): requests that say what Stripe lists - same id, same amount, in any order, some twice, with the currency or without - change nothing: no double counting`, async () => {
    let mirrored = 0
    for (let seed = 1; seed <= 300; seed++) {
      const random = mulberry32(seed * 31)
      const world = generate(random)
      const requests = mirroredRequests(random, world.evidence)
      if (requests.length === 0) continue
      mirrored++
      const base = await compute(deepClone(world.evidence))
      assert.deepEqual(await compute({ ...deepClone(world.evidence), requestedRefunds: requests }), base, `seed ${seed}`)
    }
    assert.ok(mirrored >= 100, `only ${mirrored} worlds had a request to mirror: the property is not exercised`)
  })

  test(`P1-bis A property (300 worlds, ${kind}): a request that says another amount than the refund Stripe lists under its id is named, leaves the widest interval, and no "at least X" is claimed - in any order`, async () => {
    const { retainedAtLeast } = await load()
    let applied = 0
    for (let seed = 1; seed <= 300; seed++) {
      const random = mulberry32(seed * 37)
      const world = generate(random)
      const listed = (world.evidence.refunds as { data: Array<Record<string, unknown>> }).data
      if (listed.length === 0) continue
      applied++
      const target = pick(random, listed)
      const amount = Number(target.amount)
      const requests = [
        ...mirroredRequests(random, { refunds: { data: listed.filter((item) => item !== target) } }),
        { id: target.id, amount: pick(random, [amount + 1, amount * 2, amount > 1 ? amount - 1 : amount + 2, amount === 1 ? 2 : 1]) },
        ...(random() < 0.3 ? [{ id: target.id, amount }] : []),
      ]
      const evidence = { ...deepClone(world.evidence), requestedRefunds: shuffled(random, requests) }
      const position = await compute(evidence)
      const label = `seed ${seed}`
      assert.deepEqual(position.findings.filter((entry) => entry.code === 'conflicting_duplicate').map((entry) => entry.ref), [target.id], label)
      assert.equal(position.certainty, 'uncertain', label)
      assert.equal(position.final, false, label)
      assert.equal(position.retainedCents, null, label)
      for (const wanted of [1, 2, 100, position.collectedCents ?? 1]) assert.notEqual(retainedAtLeast(position, wanted), 'yes', `${label} at least ${wanted}`)
      assert.deepEqual(await compute(permuted(mulberry32(seed), evidence)), position, `${label} order of the lists`)
      await assertWellFormed(position, label)
    }
    assert.ok(applied >= 100, `the contradiction was injected into only ${applied} worlds`)
  })
}

// An independent oracle for the requests: which ids contradict themselves (or what Stripe lists) and how much the requests that stand add to the worst case - by plain arithmetic
function requestWorld(random: Random) {
  const world = shapedWorld(random)
  const listed = (world.evidence.refunds as { data: Array<Record<string, unknown>> }).data
  const requests: Array<Record<string, unknown>> = []
  for (let index = 0, count = between(random, 0, 6); index < count; index++) {
    const kind = pick(random, ['listed_right', 'listed_wrong', 'fresh', 'fresh', 'nameless'] as const)
    if (kind === 'nameless') requests.push({ amount: between(random, 1, 9) })
    else if (kind === 'fresh') requests.push({ id: pick(random, ['re_x', 're_y']), amount: pick(random, [5, 6]), ...(random() < 0.3 ? { currency: pick(random, ['eur', 'EUR']) } : {}) })
    else if (listed.length > 0) {
      const target = pick(random, listed)
      requests.push({ id: target.id, amount: kind === 'listed_right' ? target.amount : Number(target.amount) + pick(random, [1, 2]) })
    }
  }
  return { world, listed, requests }
}
function expectedFromRequests(listed: Array<Record<string, unknown>>, requests: Array<Record<string, unknown>>) {
  const byId = new Map<string, Array<Record<string, unknown>>>()
  let counted = 0
  for (const request of requests) {
    if (request.id === undefined) counted += Number(request.amount)
    else byId.set(String(request.id), [...(byId.get(String(request.id)) ?? []), request])
  }
  const conflicts: string[] = []
  for (const [id, group] of byId) {
    const amounts = new Set(group.map((request) => Number(request.amount)))
    const stripe = listed.find((item) => item.id === id)
    if (amounts.size > 1 || (stripe !== undefined && !amounts.has(Number(stripe.amount)))) conflicts.push(id)
    else if (stripe === undefined) counted += [...amounts][0]
  }
  return { conflicts: conflicts.sort(), counted }
}
test('P1-bis A property (400 worlds): which ids contradict, and what the requests that stand add, are exactly what plain arithmetic says - in any order of the lists', async () => {
  let contradictory = 0
  for (let seed = 1; seed <= 400; seed++) {
    const { world, listed, requests } = requestWorld(mulberry32(seed * 41))
    const expected = expectedFromRequests(listed, requests)
    const evidence = { ...deepClone(world.evidence), requestedRefunds: requests }
    const position = await compute(evidence)
    const label = `seed ${seed}`
    assert.deepEqual(position.findings.filter((entry) => entry.code === 'conflicting_duplicate').map((entry) => entry.ref).sort(), expected.conflicts, label)
    assert.equal(position.refunds.requestedCents, expected.counted, label)
    if (expected.conflicts.length > 0) {
      contradictory++
      assert.equal(position.retainedLowerCents, 0, label)
      assert.equal(position.certainty, 'uncertain', label)
    }
    assert.deepEqual(await compute(permuted(mulberry32(seed), evidence)), position, `${label} order of the lists`)
    await assertWellFormed(position, label)
  }
  assert.ok(contradictory >= 80, `only ${contradictory} worlds had a contradiction among the requests`)
})

// ---- B. zero in the snapshot is not zero for good ------------------------------------------------------------------------------------------------------------------------------
test('P1-bis B - reproduction, AR-2 B with a TOTAL refund: succeeded (zero in the snapshot, not for good), then failed (all of it back) - what each question answers before and after', async () => {
  const { retainedAtLeast, retainedIsZero } = await load()
  const before = await compute(withRefunds([refund({ id: 're_1', amount: 100 })], 100))
  // the evidence of the moment: the refund succeeded, the whole capital is out - proven, zero, and provisional
  assert.equal(before.certainty, 'proven')
  assert.equal(before.retainedCents, 0)
  assert.equal(before.final, false)
  assert.equal(before.provisionalRefundCents, 100)
  assert.equal(retainedIsZero(before), 'unknown', 'before the fix this was yes: a decision that cannot be undone would have rested on a refund that can still fail')
  assert.notEqual(retainedAtLeast(before, 100), 'yes')
  // the same refund after it FAILED (the money left and came back: -100 / +100): the capital is whole, and that is final
  const after = await compute(withRefunds([failedRefund({ id: 're_1', amount: 100 })], 0))
  assert.equal(after.certainty, 'proven')
  assert.equal(after.retainedCents, 100)
  assert.equal(after.final, true)
  assert.equal(retainedIsZero(after), 'no')
  assert.equal(retainedAtLeast(after, 100), 'yes')
  assert.equal(retainedAtLeast(after, 1), 'yes')
})

test('P1-bis B - the partial refund of AR-2 B (20 of 100): something is held before the failure and all of it after - "is nothing held?" says no both times', async () => {
  const { retainedIsZero } = await load()
  const before = await compute(withRefunds([refund({ id: 're_1', amount: 20 })], 20))
  const after = await compute(withRefunds([failedRefund({ id: 're_1', amount: 20 })], 0))
  assert.equal(before.retainedCents, 80)
  assert.equal(retainedIsZero(before), 'no', 'money is held for sure, whatever happens to the refund: it can only come back')
  assert.equal(after.retainedCents, 100)
  assert.equal(retainedIsZero(after), 'no')
})

type ZeroScenario = { name: string; evidence: () => unknown; answer: 'yes' | 'no' | 'unknown'; certainty: 'proven' | 'uncertain'; final: boolean; retained: number | null }
const ZERO_SCENARIOS: ZeroScenario[] = [
  { name: 'nothing refunded, nothing disputed: all of it is held', evidence: () => ev(), answer: 'no', certainty: 'proven', final: true, retained: 100 },
  { name: 'a payment that was canceled: nothing was ever collected, and that is final', evidence: () => ev({ paymentIntent: pi({ status: 'canceled', amount_received: 0 }), charge: charge({ amount_captured: 0 }) }), answer: 'yes', certainty: 'proven', final: true, retained: 0 },
  { name: 'a total refund that succeeded: zero in the snapshot, not for good', evidence: () => withRefunds([refund({ amount: 100 })], 100), answer: 'unknown', certainty: 'proven', final: false, retained: 0 },
  { name: 'two refunds that succeeded and together take everything (60 and 40)', evidence: () => withRefunds([refund({ id: 're_a', amount: 60 }), refund({ id: 're_b', amount: 40 })], 100), answer: 'unknown', certainty: 'proven', final: false, retained: 0 },
  { name: 'more refunded than collected (120): zero, over-recovered, and still not for good', evidence: () => withRefunds([refund({ amount: 120 })], 120), answer: 'unknown', certainty: 'proven', final: false, retained: 0 },
  { name: 'a partial refund that succeeded (30): something is held for sure', evidence: () => withRefunds([refund({ amount: 30 })], 30), answer: 'no', certainty: 'proven', final: false, retained: 70 },
  { name: 'the same total refund after it FAILED (AR-2 B): all of it is back, and that is final', evidence: () => withRefunds([failedRefund({ amount: 100 })], 0), answer: 'no', certainty: 'proven', final: true, retained: 100 },
  { name: 'a LOST dispute with the withdrawal shown for the whole amount (SP1): zero, and final', evidence: () => withDisputes([dispute()]), answer: 'yes', certainty: 'proven', final: true, retained: 0 },
  { name: 'a lost dispute and a refund that FAILED (not one that can still fail): zero, and final', evidence: () => withDisputes([dispute()], { refunds: list([failedRefund({ amount: 20 })]), charge: charge({ amount_refunded: 0, disputed: true }) }), answer: 'yes', certainty: 'proven', final: true, retained: 0 },
  { name: 'a refund that succeeded (30) and a lost dispute (70) that together take everything: zero in the snapshot, not for good', evidence: () => withDisputes([dispute({ amount: 70, balance_transactions: [withdrawal(70, 2000)] })], { refunds: list([refund({ amount: 30 })]), charge: charge({ amount_refunded: 30, disputed: true }) }), answer: 'unknown', certainty: 'proven', final: false, retained: 0 },
  { name: 'a lost dispute (100) and a refund that succeeded (20): the customer recovered more than paid - zero, and not for good', evidence: () => withDisputes([dispute()], { refunds: list([refund({ amount: 20 })]), charge: charge({ amount_refunded: 20, disputed: true }) }), answer: 'unknown', certainty: 'proven', final: false, retained: 0 },
  { name: 'a WON dispute whose funds are back: all of it is held', evidence: () => withDisputes([dispute({ status: 'won', balance_transactions: [withdrawal(), reinstatement()] })]), answer: 'no', certainty: 'proven', final: true, retained: 100 },
  { name: 'a total refund that is still pending: uncertain, never "nothing is held"', evidence: () => withRefunds([refund({ status: 'pending', amount: 100 })], 100), answer: 'unknown', certainty: 'uncertain', final: false, retained: null },
  { name: 'a total refund that was requested and is not listed (yet)', evidence: () => ev({ requestedRefunds: [asked('re_9', 100)] }), answer: 'unknown', certainty: 'uncertain', final: false, retained: null },
  { name: 'a lost dispute whose withdrawal is not shown', evidence: () => withDisputes([dispute({ balance_transactions: [] })]), answer: 'unknown', certainty: 'uncertain', final: false, retained: null },
]
for (const scenario of ZERO_SCENARIOS) {
  test(`P1-bis B - "is nothing held?" - ${scenario.name}`, async () => {
    const { retainedIsZero } = await load()
    const position = await compute(scenario.evidence())
    assert.equal(position.certainty, scenario.certainty)
    assert.equal(position.final, scenario.final)
    assert.equal(position.retainedCents, scenario.retained)
    assert.equal(retainedIsZero(position), scenario.answer)
    await assertWellFormed(position, scenario.name)
  })
}

test('P1-bis B - "is nothing held?" reads the bounds, the certainty AND the finality of a position - tried on positions written by hand', async () => {
  const { retainedIsZero } = await load()
  const base = await compute(ev())
  const made = (lower: number, upper: number | null, certainty: 'proven' | 'uncertain', final: boolean): FundsPosition => ({ ...base, retainedLowerCents: lower, retainedUpperCents: upper, certainty, final })
  assert.equal(retainedIsZero(made(0, 0, 'proven', true)), 'yes')
  assert.equal(retainedIsZero(made(0, 0, 'proven', false)), 'unknown', 'a proven zero that is not final is zero in the snapshot, not for good')
  assert.equal(retainedIsZero(made(0, 0, 'uncertain', true)), 'unknown')
  assert.equal(retainedIsZero(made(0, 0, 'uncertain', false)), 'unknown')
  assert.equal(retainedIsZero(made(0, 50, 'proven', true)), 'unknown')
  assert.equal(retainedIsZero(made(0, null, 'proven', true)), 'unknown')
  assert.equal(retainedIsZero(made(5, 50, 'proven', true)), 'no')
  assert.equal(retainedIsZero(made(5, 50, 'proven', false)), 'no', 'something held for sure is no, final or not')
  assert.equal(retainedIsZero(made(5, 50, 'uncertain', false)), 'no')
  // finality is the boolean true and nothing else: a value that is merely truthy, or missing, is not finality
  for (const notTrue of [undefined, null, 0, 1, 'true', 'yes', {}, []]) {
    assert.equal(retainedIsZero({ ...made(0, 0, 'proven', true), final: notTrue as unknown as boolean }), 'unknown', String(notTrue))
  }
})

// A world in which everything is shown and the whole capital is gone: by refunds that succeeded, by disputes that were lost, or by both - and sometimes more than the capital
function splitInto(random: Random, total: number, wanted: number): number[] {
  const parts = Math.min(wanted, total)
  const amounts = Array.from({ length: parts }, () => 1)
  for (let left = total - parts; left > 0;) {
    const chunk = between(random, 1, left)
    amounts[Math.floor(random() * parts)] += chunk
    left -= chunk
  }
  return amounts
}
function zeroWorld(random: Random): { evidence: Record<string, unknown>; refunded: number } {
  const collected = between(random, 100, 20_000)
  const byRefunds = random() < 0.5 ? 0 : between(random, 1, collected)
  const over = byRefunds > 0 && random() < 0.3 ? between(random, 1, 500) : 0
  const refunds = byRefunds > 0 ? splitInto(random, byRefunds + over, between(random, 1, 3)).map((amount, index) => refund({ id: `re_${index}`, amount })) : []
  const disputes = collected - byRefunds > 0
    ? splitInto(random, collected - byRefunds, between(random, 1, 2)).map((amount, index) => dispute({ id: `dp_${index}`, amount, status: 'lost', balance_transactions: [withdrawal(amount, between(random, 0, 3_000), { id: `txn_w${index}`, source: `dp_${index}` })] }))
    : []
  const refunded = byRefunds + over
  const evidence = ev({
    paymentIntent: pi({ amount: collected, amount_received: collected }),
    charge: charge({ amount: collected, amount_captured: collected, amount_refunded: refunded, disputed: disputes.length > 0 }),
    refunds: list(refunds),
    disputes: list(disputes),
  })
  return { evidence, refunded }
}
test('P1-bis B property (600 worlds): where everything is shown, "is nothing held?" is no when something is held, yes when disputes alone took the capital, unknown when a refund that succeeded is part of it', async () => {
  const { retainedIsZero } = await load()
  const seen = { yes: 0, unknown: 0, no: 0 }
  for (let seed = 1; seed <= 300; seed++) {
    const world = zeroWorld(mulberry32(seed * 43))
    const position = await compute(world.evidence)
    const label = `zero world ${seed}`
    assert.equal(position.certainty, 'proven', label)
    assert.equal(position.retainedCents, 0, label)
    assert.equal(position.final, world.refunded === 0, label)
    const answer = retainedIsZero(position)
    assert.equal(answer, world.refunded === 0 ? 'yes' : 'unknown', label)
    seen[answer]++
    await assertWellFormed(position, label)
  }
  for (let seed = 1; seed <= 300; seed++) {
    const world = provenWorld(mulberry32(seed))
    const position = await compute(world.evidence)
    const label = `proven world ${seed}`
    const retained = Math.max(0, world.collected - world.confirmed - world.lost)
    const answer = retainedIsZero(position)
    assert.equal(answer, retained > 0 ? 'no' : world.confirmed === 0 ? 'yes' : 'unknown', label)
    seen[answer]++
  }
  assert.ok(seen.yes >= 20 && seen.unknown >= 20 && seen.no >= 100, `the property did not exercise every answer: ${JSON.stringify(seen)}`)
})

// KNOWN LIMIT, NOT CHANGED by P1-bis (docs/VERIFICA-4.6.md S6a.20). "At least X?" answers 'no' from the BEST reading of the snapshot, and for a position that is not final that best reading is not for
// good either: a refund that succeeded can still fail and the money is back (AR-2 B). The audit asked for the question "is nothing held?" to be conservative; this one was not asked, it stays as
// it was, and it is pinned here so that nobody changes it - or relies on its 'no' for a decision that cannot be undone - without seeing this.
test('KNOWN LIMIT (not changed by P1-bis) - "at least X?" still answers no from the best reading of a snapshot that is not final, and yes once the refund has failed', async () => {
  const { retainedAtLeast } = await load()
  const snapshot = await compute(withRefunds([refund({ id: 're_1', amount: 100 })], 100))
  assert.equal(snapshot.final, false)
  assert.equal(retainedAtLeast(snapshot, 1), 'no')
  const later = await compute(withRefunds([failedRefund({ id: 're_1', amount: 100 })], 0))
  assert.equal(retainedAtLeast(later, 1), 'yes')
})

// The requests are checked against EACH OTHER first and against Stripe second: two requests that disagree are a contradiction by themselves, even when the refund Stripe lists under their id was
// set aside for another reason (and has said why). Nothing is dropped because something else is wrong.
test('P1-bis A - two requests that disagree are named even when the refund Stripe lists under their id was set aside', async () => {
  const position = await compute(withRefunds([refund({ id: 're_1', amount: 20, payment_intent: 'pi_other' })], 20, { requestedRefunds: [asked('re_1', 20), asked('re_1', 80)] }))
  assert.deepEqual(allCodes(position), ['conflict:conflicting_duplicate', 'conflict:foreign_evidence', 'uncertainty:refunded_amount_unexplained'])
  assert.equal(finding(position, 'conflicting_duplicate')?.ref, 're_1')
  assert.equal(position.refunds.requestedCents, 0)
  bounds(position, 0, 100)
})

// An id is compared exactly as it is written: nothing is merged by looking alike. A request for re_a is not the refund RE_A that Stripe lists (and the other way round); each stands on its own.
test('P1-bis A - ids are compared exactly as written: a request for re_a is not the refund RE_A that Stripe lists, and the other way round', async () => {
  const upperListed = await compute(withRefunds([refund({ id: 'RE_A', amount: 20 })], 20, { requestedRefunds: [asked('re_a', 20)] }))
  assert.deepEqual(allCodes(upperListed), ['uncertainty:refund_requested'])
  assert.equal(upperListed.refunds.requestedCents, 20, 'the request is a request of its own: it counts in the worst case')
  bounds(upperListed, 60, 80)
  const lowerListed = await compute(withRefunds([refund({ id: 're_a', amount: 20 })], 20, { requestedRefunds: [asked('RE_A', 20)] }))
  assert.deepEqual(allCodes(lowerListed), ['uncertainty:refund_requested'])
  assert.equal(lowerListed.refunds.requestedCents, 20)
  bounds(lowerListed, 60, 80)
  // and two requests whose ids differ only in case are two requests, not one that contradicts itself
  const two = await compute(ev({ requestedRefunds: [asked('re_a', 20), asked('RE_A', 30)] }))
  assert.deepEqual(two.findings.map((entry) => `${entry.code}:${entry.ref}`), ['refund_requested:RE_A', 'refund_requested:re_a'], 'one request each, none contradicting the other')
  assert.equal(two.refunds.requestedCents, 50)
})
