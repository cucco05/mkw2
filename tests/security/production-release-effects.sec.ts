// Step 4.6, S4 - effects on OUTSIDE services whose outcome can be unknown (PrintLab, StockWorks), and operations that overlap.
//
// What is proven here, with LOCAL fake HTTP servers (tests/security/_fake-services.ts) that count every request and can misbehave at the exact call that matters:
//   * an intent is written BEFORE the call; a request that never left is "not sent" and may be repeated; a refusal by the service is "rejected" and may be repeated;
//   * a request the service MAY have received - an error after it was received, a lost answer, a timeout, a restart of this process - is UNCERTAIN: it is never sent
//     again, however many times it is asked and however long it has been; it is looked for on the service (a record that is found is proof); not finding it proves
//     nothing and the effect stays uncertain; an administrator can end the doubt only by naming a record that the SERVER verifies on the service - there is no
//     "it did not happen, send it again";
//   * two requests at once send once; a block on the payment that lands during the work is recorded, not undone, and nothing is ever sent to a printer to stop a job;
//   * an order whose metadata was erased (an erased account) has lost its history: its effects start uncertain.
// No printer, PrintLab, StockWorks or Stripe account is ever contacted.
import './_harness'
import { db } from './_harness'
import {
  as, assertNothingHappened, auditActions, bodyOf, callAssign, callAutoQueue, callEffects, callSubmit, closedPort, journalOf, makeOrder, releasedSpec, resetSeams, setup, sleep, snap, state, teardown, world,
} from './_release-fixtures'
import { startFakePrintLab } from './_fake-services'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { releaseHooks } from '../../lib/production-release'
import { INTENT_CLAIM_TTL_MS } from '../../lib/external-effects'

test.before(setup)
test.after(teardown)
afterEach(() => {
  resetSeams()
  process.env.PRINTLAB_BASE_URL = state.printLab.url
})

const PAST = () => new Date(Date.now() - INTENT_CLAIM_TTL_MS - 60_000).toISOString()
const itemsOf = async (orderId: string) => (await db()).printOrderItem.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })

// an intent left behind by a process that died: nobody ever wrote its outcome
async function leaveDeadIntent(orderId: string, kind: 'printlab' | 'stockworks' = 'printlab') {
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
  const items = await itemsOf(orderId)
  const past = PAST()
  const record = (key: string, detail: Record<string, unknown>) => [key, {
    kind: kind === 'printlab' ? 'printlab_submit' : 'stockworks_movement', state: 'intent', intentId: `dead-process-${key}`, attempts: 1, startedAt: past, claimUntil: past,
    by: 'makerworks_admin', adminId: null, detail, externalId: null, confirmedBy: null, cause: null, httpStatus: null, message: null, at: past, blockedAfterSend: false,
  }]
  const effects = Object.fromEntries(items.map((item) => record(`printlab:item:${item.id}`, {
    idempotencyKey: `makerworks-order:${orderId}:item:${item.id}`, itemId: item.id, sourceOrderId: orderId,
  })))
  await prisma.printOrder.update({ where: { id: orderId }, data: { metadata: { ...(order.metadata as object), externalEffects: effects } as any } })
  return items
}
const onlyEffect = async (orderId: string) => Object.values(await journalOf(orderId))[0]

// ============================================================================================================================================
// B. PrintLab
// ============================================================================================================================================
test('B0 the intent is already written when the call is made, with a claim that runs out', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  let seen: any = null
  releaseHooks.beforeExternalCall = async () => { seen = await onlyEffect(order.id) }
  const res = await callSubmit(order.id)
  assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
  assert.equal(seen.state, 'intent', 'written before PrintLab was called')
  assert.ok(Date.parse(seen.claimUntil) > Date.now(), 'with a claim that is still live')
  assert.equal(state.printLab.submissions().length, 1)
  const end = await onlyEffect(order.id)
  assert.deepEqual([end.state, end.confirmedBy, end.claimUntil, end.attempts], ['confirmed', 'response', null, 1])
})

test('B1 error BEFORE sending (PrintLab not reached): nothing happened, the item is "not sent", and sending again works', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  process.env.PRINTLAB_BASE_URL = `http://127.0.0.1:${await closedPort()}` // nothing listens here: the connection is refused
  const first = await callSubmit(order.id)
  assert.equal(first.status, 400)
  assert.notEqual((await bodyOf(first)).code, 'SUBMIT_OUTCOME_UNKNOWN', 'a request that never left is not an unknown outcome')
  assert.equal(state.printLab.requests.length, 0)
  const failed = await onlyEffect(order.id)
  assert.equal(failed.state, 'not_sent')
  assert.equal(failed.cause, 'econnrefused')
  process.env.PRINTLAB_BASE_URL = state.printLab.url
  const second = await callSubmit(order.id)
  assert.equal(second.status, 200, JSON.stringify(await bodyOf(second)))
  assert.equal(state.printLab.submissions().length, 1)
  const done = await onlyEffect(order.id)
  assert.deepEqual([done.state, done.attempts], ['confirmed', 2])
})

test('B1b PrintLab refuses the request (4xx): it did nothing, and sending again once the cause is fixed works', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  state.printLab.mode.submit = { kind: 'reject', status: 422, message: 'unknown model' }
  const first = await callSubmit(order.id)
  assert.equal(first.status, 400)
  assert.equal((await onlyEffect(order.id)).state, 'rejected')
  assert.equal(state.printLab.jobs.length, 0)
  state.printLab.mode.submit = { kind: 'ok' }
  assert.equal((await callSubmit(order.id)).status, 200)
  assert.equal(state.printLab.jobs.length, 1)
})

test('B2 error AFTER PrintLab received the request (500): uncertain, never sent again, found on PrintLab by its key', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  state.printLab.mode.submit = { kind: 'status', status: 500, record: true }
  const first = await callSubmit(order.id)
  assert.equal(first.status, 409)
  assert.equal((await bodyOf(first)).code, 'SUBMIT_OUTCOME_UNKNOWN')
  assert.equal(state.printLab.jobs.length, 1, 'PrintLab did create the job')
  const doubt = await onlyEffect(order.id)
  assert.deepEqual([doubt.state, doubt.cause, doubt.httpStatus], ['uncertain', 'server_error', 500])
  // PrintLab is healthy again
  state.printLab.mode.submit = { kind: 'ok' }
  const second = await callSubmit(order.id)
  assert.equal(second.status, 200, JSON.stringify(await bodyOf(second)))
  assert.equal(state.printLab.submissions().length, 1, 'the job was FOUND, not sent a second time')
  const found = await onlyEffect(order.id)
  assert.deepEqual([found.state, found.confirmedBy, found.externalId], ['confirmed', 'reconciliation', state.printLab.jobs[0].id])
  // the order's list of submissions shows the job
  const prisma = await db()
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.ok(JSON.stringify((row.metadata as any).printLabSubmissions).includes(state.printLab.jobs[0].id))
  // and once confirmed, asking again does nothing at all
  assert.equal((await callSubmit(order.id)).status, 200)
  assert.equal(state.printLab.submissions().length, 1)
})

test('B3 LOST response (connection dropped after the request arrived): uncertain, never sent again', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  state.printLab.mode.submit = { kind: 'drop', record: true }
  const first = await callSubmit(order.id)
  assert.equal(first.status, 409)
  assert.equal((await onlyEffect(order.id)).state, 'uncertain')
  assert.equal(state.printLab.submissions().length, 1)
  state.printLab.mode.submit = { kind: 'ok' }
  for (let i = 0; i < 3; i++) assert.ok([200, 409].includes((await callSubmit(order.id)).status))
  assert.equal(state.printLab.submissions().length, 1, 'however often it is asked, the request is not repeated')
})

test('B4 TIMEOUT (PrintLab is slow): uncertain, never sent again, the job is found later', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  state.printLab.mode.submit = { kind: 'delay', ms: 2600, record: true }
  const started = Date.now()
  const first = await callSubmit(order.id)
  assert.ok(Date.now() - started < 2400, 'the call was abandoned at the timeout, not waited for')
  assert.equal(first.status, 409)
  const doubt = await onlyEffect(order.id)
  assert.deepEqual([doubt.state, doubt.cause], ['uncertain', 'timeout'])
  state.printLab.mode.submit = { kind: 'ok' }
  const second = await callSubmit(order.id)
  assert.equal(second.status, 200, JSON.stringify(await bodyOf(second)))
  assert.equal(state.printLab.submissions().length, 1)
  assert.equal((await onlyEffect(order.id)).confirmedBy, 'reconciliation')
})

test('B3b an answer that is not a record (200 with garbage): uncertain', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  state.printLab.mode.submit = { kind: 'garbled', record: true }
  const first = await callSubmit(order.id)
  assert.equal(first.status, 409)
  const doubt = await onlyEffect(order.id)
  assert.deepEqual([doubt.state, doubt.cause], ['uncertain', 'bad_response'])
})

test('B5 when PrintLab does not list jobs the doubt stays: not finding a job proves nothing, so nothing is sent again - however often', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  const quiet = await startFakePrintLab({ listJobs: false })
  try {
    process.env.PRINTLAB_BASE_URL = quiet.url
    quiet.mode.submit = { kind: 'status', status: 503, record: true }
    assert.equal((await callSubmit(order.id)).status, 409)
    quiet.mode.submit = { kind: 'ok' }
    for (let i = 0; i < 3; i++) {
      const again = await callSubmit(order.id)
      assert.equal(again.status, 409, 'still unknown')
      assert.equal((await bodyOf(again)).code, 'SUBMIT_OUTCOME_UNKNOWN')
    }
    assert.equal(quiet.submissions().length, 1, 'one request in total')
    assert.equal((await onlyEffect(order.id)).state, 'uncertain')
  } finally {
    await quiet.close()
  }
})

test('B6 a RESTART of this process: an intent that nobody completed is uncertain after its claim runs out - never sent again, found if PrintLab has it', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  const [item] = await leaveDeadIntent(order.id)
  // not found on PrintLab, asked three times, hours later: no request is ever made
  for (let i = 0; i < 3; i++) {
    const res = await callSubmit(order.id)
    assert.equal(res.status, 409)
    assert.equal((await bodyOf(res)).code, 'SUBMIT_OUTCOME_UNKNOWN')
  }
  assert.equal(state.printLab.submissions().length, 0, 'the claim running out is not a license to send again')
  const doubt = await onlyEffect(order.id)
  assert.deepEqual([doubt.state, doubt.cause], ['uncertain', 'claim_expired'])
  // PrintLab does have the job (the dead process had sent it)
  state.printLab.jobs.push({ id: 'pl_from_the_dead_process', status: 'queued', source_order_id: order.id, source_job_id: null, idempotency_key: `makerworks-order:${order.id}:item:${item.id}`, model_id: null, metadata: { item_id: item.id } })
  const found = await callSubmit(order.id)
  assert.equal(found.status, 200, JSON.stringify(await bodyOf(found)))
  assert.equal(state.printLab.submissions().length, 0)
  const confirmed = await onlyEffect(order.id)
  assert.deepEqual([confirmed.state, confirmed.confirmedBy, confirmed.externalId], ['confirmed', 'reconciliation', 'pl_from_the_dead_process'])
})

test('B7 two requests at once send once; the second is told so', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  let second: Response | null = null
  releaseHooks.beforeExternalCall = async () => {
    releaseHooks.beforeExternalCall = undefined
    second = await callSubmit(order.id)
  }
  const first = await callSubmit(order.id)
  assert.equal(first.status, 200, JSON.stringify(await bodyOf(first)))
  assert.equal(second!.status, 409)
  assert.equal((await bodyOf(second!)).code, 'SUBMIT_IN_PROGRESS')
  assert.equal(state.printLab.submissions().length, 1)
})

test('B7b many requests at once: still one request to PrintLab per item', async () => {
  await world()
  const order = await makeOrder(releasedSpec({ items: 3 }))
  state.printLab.mode.submit = { kind: 'delay', ms: 300, record: true }
  const results = await Promise.all(Array.from({ length: 6 }, () => callSubmit(order.id)))
  const codes = await Promise.all(results.map(async (res) => (res.status === 200 ? 'ok' : (await bodyOf(res)).code)))
  assert.ok(codes.includes('ok'), 'one of them did the work')
  assert.ok(codes.every((code) => code === 'ok' || code === 'SUBMIT_IN_PROGRESS'), `the others were told it is in progress (or found it done): ${codes.join(', ')}`)
  assert.ok(codes.includes('SUBMIT_IN_PROGRESS'), 'at least one overlapped')
  assert.equal(state.printLab.submissions().length, 3, 'one request per item, however many callers')
})

test('B8 a payment problem that lands DURING the call is recorded, nothing is undone, and nothing is ever sent to a printer', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  const prisma = await db()
  releaseHooks.beforeExternalCall = async () => {
    releaseHooks.beforeExternalCall = undefined
    await prisma.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: 'dispute' } })
  }
  const res = await callSubmit(order.id)
  assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
  assert.equal(state.printLab.submissions().length, 1, 'the request had already been made')
  const effect = await onlyEffect(order.id)
  assert.deepEqual([effect.state, effect.blockedAfterSend], ['confirmed', true])
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(row.status, 'queued', 'the status is not touched')
  assert.equal(row.paymentReviewReason, 'dispute')
  assert.equal(state.printLab.otherCalls().length, 0, 'no stop, pause or cancel command was sent to PrintLab or a printer')
})

test('B9 a block between two items stops the rest; once it is resolved only the missing item is sent - one request per item in all', async () => {
  await world()
  const order = await makeOrder(releasedSpec({ items: 2 }))
  const prisma = await db()
  releaseHooks.afterExternalCall = async () => {
    releaseHooks.afterExternalCall = undefined
    await prisma.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: 'duplicate_payment' } })
  }
  const first = await callSubmit(order.id)
  assert.equal(first.status, 409)
  assert.equal((await bodyOf(first)).code, 'RELEASE_CHANGED')
  assert.equal(state.printLab.submissions().length, 1, 'the second item was not sent')
  const states = Object.values(await journalOf(order.id)).map((entry) => entry.state).sort()
  assert.deepEqual(states, ['confirmed', 'not_sent'])
  // while the payment is on hold nothing more is sent
  const blocked = await callSubmit(order.id)
  assert.equal(blocked.status, 409)
  assert.equal((await bodyOf(blocked)).code, 'PAYMENT_ON_HOLD')
  assert.equal(state.printLab.submissions().length, 1)
  // the hold is resolved: only the item that is missing goes
  await prisma.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: null } })
  const resumed = await callSubmit(order.id)
  assert.equal(resumed.status, 200, JSON.stringify(await bodyOf(resumed)))
  assert.equal(state.printLab.submissions().length, 2, 'one request per item in total')
  assert.deepEqual(Object.values(await journalOf(order.id)).map((entry) => entry.state), ['confirmed', 'confirmed'])
})

test('B9b another process took over the next item between two calls: this one does not send it, and the other process\'s record is left alone', async () => {
  await world()
  const order = await makeOrder(releasedSpec({ items: 2 }))
  const prisma = await db()
  const items = await itemsOf(order.id)
  // right after the first call (before this process looks at the second item again) the claim on the second item has passed to someone else
  releaseHooks.afterExternalCall = async () => {
    releaseHooks.afterExternalCall = undefined
    const sentKey = String(state.printLab.submissions()[0].body?.idempotency_key)
    const second = items.find((item) => !sentKey.includes(item.id))!
    const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
    const metadata = row.metadata as any
    const key = `printlab:item:${second.id}`
    metadata.externalEffects[key] = { ...metadata.externalEffects[key], intentId: 'another-process', claimUntil: new Date(Date.now() + 60_000).toISOString() }
    await prisma.printOrder.update({ where: { id: order.id }, data: { metadata } })
  }
  const res = await callSubmit(order.id)
  assert.equal(res.status, 409, JSON.stringify(await bodyOf(res)))
  assert.equal((await bodyOf(res)).code, 'RELEASE_CHANGED')
  assert.equal(state.printLab.submissions().length, 1, 'the item whose claim was lost was sent anyway')
  const journal = Object.values(await journalOf(order.id))
  assert.deepEqual(journal.map((entry) => entry.state).sort(), ['confirmed', 'intent'], 'the first is done; the second is still the other process\'s intent')
  assert.equal(journal.find((entry) => entry.state === 'intent')!.intentId, 'another-process', 'the other process\'s record was not touched')
})

test('B10 an order whose metadata was erased has lost its history: nothing is sent, the job is looked for, and only a found job ends the doubt', async () => {
  await world()
  const order = await makeOrder(releasedSpec({ wipeMetadata: true }))
  const first = await callSubmit(order.id)
  assert.equal(first.status, 409)
  assert.equal((await bodyOf(first)).code, 'SUBMIT_OUTCOME_UNKNOWN')
  assert.equal(state.printLab.submissions().length, 0)
  const doubt = await onlyEffect(order.id)
  assert.deepEqual([doubt.state, doubt.cause], ['uncertain', 'metadata_lost'])
  // it stays so
  assert.equal((await callSubmit(order.id)).status, 409)
  assert.equal(state.printLab.submissions().length, 0)
  const [item] = await itemsOf(order.id)
  state.printLab.jobs.push({ id: 'pl_before_the_erasure', status: 'printing', source_order_id: order.id, source_job_id: null, idempotency_key: `makerworks-order:${order.id}:item:${item.id}`, model_id: null, metadata: { item_id: item.id } })
  assert.equal((await callSubmit(order.id)).status, 200)
  assert.equal(state.printLab.submissions().length, 0, 'found, not sent again')
})

test('B11 a non-released or non-queued order is refused before any intent is written', async () => {
  await world()
  const unpaid = await makeOrder({ name: 'unpaid', status: 'queued' })
  const before = await snap(unpaid.id)
  const res = await callSubmit(unpaid.id)
  assert.equal(res.status, 409)
  assertNothingHappened(before, await snap(unpaid.id), 'unpaid submit')
  assert.deepEqual(await journalOf(unpaid.id), {}, 'no intent was written')
  const waiting = await makeOrder(releasedSpec({ status: 'awaiting_review' }))
  const refused = await callSubmit(waiting.id)
  assert.equal(refused.status, 409)
  assert.equal((await bodyOf(refused)).code, 'ORDER_STATUS_NOT_ALLOWED')
  assert.equal(state.printLab.requests.length, 0)
})

// ---- the administrator's way out: a record the SERVER verifies ------------------------------------------------------------------------------------
test('B12 an administrator can end the doubt only with a PrintLab job the server verifies - never with a word, never with "send it again"', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  const other = await makeOrder(releasedSpec())
  state.printLab.mode.submit = { kind: 'drop', record: true }
  assert.equal((await callSubmit(order.id)).status, 409)
  const key = Object.keys(await journalOf(order.id))[0]
  const mine = state.printLab.jobs[0]
  {
    // who may, and from where
    asStaff()
    assert.equal((await callEffects('POST', order.id, { effectKey: key, externalId: mine.id, reason: 'I saw it in PrintLab' })).status, 403)
    asAdmin()
    assert.equal((await callEffects('POST', order.id, { effectKey: key, externalId: mine.id, reason: 'I saw it in PrintLab' }, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await callEffects('POST', order.id, { effectKey: key, externalId: mine.id })).status, 400, 'a written reason is required')
    // there is no action that unblocks without proof: unknown fields are refused, whatever they are called
    for (const extra of [{ action: 'retry' }, { allowRetry: true }, { notDone: true }, { force: true }]) {
      const res = await callEffects('POST', order.id, { effectKey: key, externalId: mine.id, reason: 'I saw it in PrintLab', ...extra })
      assert.equal(res.status, 400, JSON.stringify(extra))
    }
    const unchanged = await onlyEffect(order.id)
    assert.equal(unchanged.state, 'uncertain')

    // a job that does not exist, one that belongs to another order, one named without a record: no proof
    state.printLab.jobs.push({ id: 'pl_of_another_order', status: 'queued', source_order_id: other.id, source_job_id: null, idempotency_key: `makerworks-order:${other.id}:item:xyz`, model_id: null, metadata: { item_id: 'xyz' } })
    for (const externalId of ['pl_does_not_exist', 'pl_of_another_order']) {
      const res = await callEffects('POST', order.id, { effectKey: key, externalId, reason: 'I am sure it was sent' })
      assert.equal(res.status, 409, externalId)
      assert.equal((await bodyOf(res)).code, 'NO_RELIABLE_PROOF')
    }
    assert.equal((await onlyEffect(order.id)).state, 'uncertain', 'still unknown')
    assert.ok((await auditActions(order.id)).includes('admin.order.external_effect.proof_refused'), 'the attempt leaves a trace')
    assert.equal(state.printLab.submissions().length, 1, 'and nothing was sent again')

    // the right job: it belongs to this order and item (by the idempotency key the server sent)
    const ok = await callEffects('POST', order.id, { effectKey: key, externalId: mine.id, reason: 'seen in PrintLab, job is queued' })
    assert.equal(ok.status, 200, JSON.stringify(await bodyOf(ok)))
    const confirmed = await onlyEffect(order.id)
    assert.deepEqual([confirmed.state, confirmed.confirmedBy, confirmed.externalId, confirmed.adminId], ['confirmed', 'admin_proof', mine.id, state.adminId])
    assert.ok((await auditActions(order.id)).includes('admin.order.external_effect.confirm'))
    assert.equal((await callEffects('POST', order.id, { effectKey: key, externalId: mine.id, reason: 'again, to be sure' })).status, 409, 'already confirmed')
    // asking to send again now does nothing
    assert.equal((await callSubmit(order.id)).status, 200)
    assert.equal(state.printLab.submissions().length, 1)
    // the list shows it
    const list = await bodyOf(await callEffects('GET', order.id))
    assert.equal(list.unresolved, 0)
    assert.equal(list.effects[0].state, 'confirmed')
  }
})

const asAdmin = () => as(state.viewers.admin)
const asStaff = () => as(state.viewers.staff)

// ============================================================================================================================================
// C. StockWorks
// ============================================================================================================================================
const SLICER = { slicerStats: { materials: [{ material: 'PLA', grams: 20, colors: ['black'] }, { material: 'PETG', grams: 10, colors: ['white'] }] } }
const consumable = (over: Record<string, unknown> = {}) => releasedSpec({ status: 'completed', metadata: SLICER, ...over })
const stockEffects = async (orderId: string) => Object.entries(await journalOf(orderId)).filter(([, record]) => record.kind === 'stockworks_movement')

test('C1 every line is journalled before it is written; all confirmed marks the order consumed', async () => {
  await world()
  const { maybeConsumeStockForOrder } = await import('../../lib/stockworks-consumption')
  const order = await makeOrder(consumable())
  const seen: string[] = []
  releaseHooks.beforeExternalCall = async ({ effectKey }) => { seen.push(`${effectKey}:${(await journalOf(order.id))[effectKey]?.state}`) }
  const result = await maybeConsumeStockForOrder(order.id, 'test')
  assert.deepEqual(result, { ok: true, movements: 2 })
  assert.equal(state.stockWorks.posts().length, 2)
  assert.ok(seen.length === 2 && seen.every((entry) => entry.endsWith(':intent')), `intent first: ${seen.join(', ')}`)
  const prisma = await db()
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.ok((row.metadata as any).stockworksConsumedAt)
  assert.equal(await maybeConsumeStockForOrder(order.id, 'test again').then((r) => (r as any).reason), 'already_consumed')
  assert.equal(state.stockWorks.posts().length, 2)
})

for (const [name, mode] of [
  ['an error after the request arrived (500)', { kind: 'status', status: 500, record: true }],
  ['a lost answer (connection dropped)', { kind: 'drop', record: true }],
  ['a timeout', { kind: 'delay', ms: 2600, record: true }],
  ['an answer that is not a record', { kind: 'garbled', record: true }],
] as const) {
  test(`C2 ${name} on the second line: that line is uncertain and is not written again; the movement is found on StockWorks`, async () => {
    await world()
    const { maybeConsumeStockForOrder } = await import('../../lib/stockworks-consumption')
    const order = await makeOrder(consumable())
    let calls = 0
    releaseHooks.afterExternalCall = async () => {
      calls += 1
      if (calls === 1) state.stockWorks.mode.movement = mode as any
    }
    const first = await maybeConsumeStockForOrder(order.id, 'test')
    assert.equal(first.ok, false)
    assert.equal((first as any).reason, 'outcome_unknown')
    assert.equal(state.stockWorks.posts().length, 2)
    const states = (await stockEffects(order.id)).map(([, record]) => record.state).sort()
    assert.deepEqual(states, ['confirmed', 'uncertain'])
    const prisma = await db()
    assert.equal(((await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).metadata as any).stockworksConsumedAt, undefined, 'not marked consumed')
    // StockWorks is healthy again: the movement is FOUND (it was recorded), nothing is written a third time
    releaseHooks.afterExternalCall = undefined
    state.stockWorks.mode.movement = { kind: 'ok' }
    const second = await maybeConsumeStockForOrder(order.id, 'test retry')
    assert.deepEqual(second, { ok: true, movements: 2 })
    assert.equal(state.stockWorks.posts().length, 2, 'never written again')
    assert.equal(state.stockWorks.movements.length, 2)
    const confirmations = (await stockEffects(order.id)).map(([, record]) => record.confirmedBy).sort()
    assert.deepEqual(confirmations, ['reconciliation', 'response'])
  })
}

test('C3 a movement that StockWorks never recorded is still uncertain: not finding it is not proof, so it is not written again', async () => {
  await world()
  const { maybeConsumeStockForOrder } = await import('../../lib/stockworks-consumption')
  const order = await makeOrder(consumable())
  let calls = 0
  releaseHooks.afterExternalCall = async () => {
    calls += 1
    if (calls === 1) state.stockWorks.mode.movement = { kind: 'status', status: 502, record: false }
  }
  const first = await maybeConsumeStockForOrder(order.id, 'test')
  assert.equal((first as any).reason, 'outcome_unknown')
  releaseHooks.afterExternalCall = undefined
  state.stockWorks.mode.movement = { kind: 'ok' }
  for (let i = 0; i < 3; i++) {
    const again = await maybeConsumeStockForOrder(order.id, 'test retry')
    assert.equal((again as any).reason, 'outcome_unknown')
  }
  assert.equal(state.stockWorks.posts().length, 2, 'one request per line in total')
  assert.equal(state.stockWorks.movements.length, 1)
})

test('C4 two consumptions at once write each line once', async () => {
  await world()
  const { maybeConsumeStockForOrder } = await import('../../lib/stockworks-consumption')
  const order = await makeOrder(consumable())
  state.stockWorks.mode.movement = { kind: 'delay', ms: 300, record: true }
  const [a, b, c] = await Promise.all([maybeConsumeStockForOrder(order.id, 'a'), maybeConsumeStockForOrder(order.id, 'b'), maybeConsumeStockForOrder(order.id, 'c')])
  const ok = [a, b, c].filter((result) => result.ok)
  assert.equal(ok.length, 1)
  assert.deepEqual([a, b, c].filter((result) => !result.ok).map((result) => (result as any).reason), ['in_progress', 'in_progress'])
  assert.equal(state.stockWorks.posts().length, 2)
})

test('C5 a block between two lines stops the rest; once it is resolved only the missing line is written', async () => {
  await world()
  const { maybeConsumeStockForOrder } = await import('../../lib/stockworks-consumption')
  const order = await makeOrder(consumable())
  const prisma = await db()
  releaseHooks.afterExternalCall = async () => {
    releaseHooks.afterExternalCall = undefined
    await prisma.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: 'dispute' } })
  }
  const first = await maybeConsumeStockForOrder(order.id, 'test')
  assert.equal(first.ok, false)
  assert.equal((first as any).reason, 'stopped')
  assert.equal(state.stockWorks.posts().length, 1)
  assert.equal((await maybeConsumeStockForOrder(order.id, 'while held') as any).reason, 'not_released')
  assert.equal(state.stockWorks.posts().length, 1)
  await prisma.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: null } })
  assert.deepEqual(await maybeConsumeStockForOrder(order.id, 'resumed'), { ok: true, movements: 2 })
  assert.equal(state.stockWorks.posts().length, 2, 'the first line was not written again')
})

test('C6 an order whose metadata was erased: the movements are looked for, never written blindly', async () => {
  await world()
  const { maybeConsumeStockForOrder } = await import('../../lib/stockworks-consumption')
  const order = await makeOrder(consumable({ wipeMetadata: true }))
  // (the slicer statistics went with the metadata: the lines come from the model's estimate)
  const first = await maybeConsumeStockForOrder(order.id, 'test')
  assert.equal(first.ok, false)
  assert.equal((first as any).reason, 'outcome_unknown')
  assert.equal(state.stockWorks.posts().length, 0, 'nothing was written')
  const lines = await stockEffects(order.id)
  assert.ok(lines.length > 0)
  assert.ok(lines.every(([, record]) => record.state === 'uncertain' && record.cause === 'metadata_lost'))
  // it stays so
  assert.equal((await maybeConsumeStockForOrder(order.id, 'again') as any).reason, 'outcome_unknown')
  assert.equal(state.stockWorks.posts().length, 0)
  // StockWorks does show the movements (they were written before the erasure): found, not written again
  for (const [, record] of lines) {
    state.stockWorks.movements.push({ id: 900 + state.stockWorks.movements.length, inventory_item_id: Number(record.detail.inventoryItemId), change_grams: Number(record.detail.changeGrams), movement_type: 'outgoing', reference: String(record.detail.reference), note: null })
  }
  const found = await maybeConsumeStockForOrder(order.id, 'after finding them')
  assert.equal(found.ok, true, JSON.stringify(found))
  assert.equal(state.stockWorks.posts().length, 0)
})

test('C7 a refusal for payment writes nothing and calls nothing', async () => {
  await world()
  const { maybeConsumeStockForOrder } = await import('../../lib/stockworks-consumption')
  const order = await makeOrder(consumable({ reason: 'amount' }))
  const before = await snap(order.id)
  const result = await maybeConsumeStockForOrder(order.id, 'test')
  assert.deepEqual([result.ok, (result as any).reason, (result as any).code], [false, 'not_released', 'PAYMENT_ON_HOLD'])
  assertNothingHappened(before, await snap(order.id), 'stock')
  assert.equal(state.stockWorks.requests.length, 0, 'StockWorks was not even asked for its inventory')
})

// ============================================================================================================================================
// D. Operations that overlap
// ============================================================================================================================================
test('D1 an operation held under the lock makes a payment hold WAIT; both end up applied, in that order', async () => {
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  const order = await makeOrder(releasedSpec())
  let holdSettled = false
  let holdWrite: Promise<void> | null = null
  releaseHooks.afterLock = async ({ action }) => {
    if (action !== 'assign-printer') return
    releaseHooks.afterLock = undefined
    // what the payment sync does: lock the order row, then write the hold
    holdWrite = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${order.id} FOR UPDATE`
      await tx.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: 'dispute' } })
    }).then(() => { holdSettled = true })
    await sleep(500)
    assert.equal(holdSettled, false, 'the hold could not be written while the assignment held the order')
  }
  const res = await callAssign(order.id, printer.id)
  assert.equal(res.status, 200)
  await holdWrite
  assert.equal(holdSettled, true)
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(row.printerId, printer.id, 'the assignment was decided on the facts as they were')
  assert.equal(row.paymentReviewReason, 'dispute', 'and the hold arrived after it')
  // from now on the order is blocked
  assert.equal((await callAssign(order.id, printer.id)).status, 409)
})

test('D2 a hold committed first refuses the operation, and the order is left untouched', async () => {
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  const order = await makeOrder(releasedSpec())
  await prisma.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: 'dispute' } })
  const before = await snap(order.id)
  const res = await callAssign(order.id, printer.id)
  assert.equal(res.status, 409)
  assertNothingHappened(before, await snap(order.id), 'assign after a hold')
})

test('D3 two automatic queues at once: every order gets one printer, none twice, and an order on hold gets none', async () => {
  await world()
  const prisma = await db()
  await prisma.printer.createMany({ data: [{ name: 'FAKE A1 mini 1' }, { name: 'FAKE A1 mini 2' }, { name: 'FAKE A1 mini 3' }] })
  const orders = [await makeOrder(releasedSpec()), await makeOrder(releasedSpec()), await makeOrder(releasedSpec())]
  const held = await makeOrder(releasedSpec({ reason: 'amount' }))
  const results = await Promise.all([callAutoQueue(), callAutoQueue(), callAutoQueue()])
  for (const res of results) assert.equal(res.status, 200)
  const rows = await prisma.printOrder.findMany({ where: { id: { in: orders.map((order) => order.id) } } })
  assert.ok(rows.every((row) => row.printerId), 'every released order has a printer')
  assert.equal(new Set(rows.map((row) => row.id)).size, 3)
  for (const order of orders) {
    const assignments = (await auditActions(order.id)).filter((action) => action === 'admin.order.printer.auto_assign')
    assert.equal(assignments.length, 1, 'assigned exactly once')
  }
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: held.id } })).printerId, null)
})
