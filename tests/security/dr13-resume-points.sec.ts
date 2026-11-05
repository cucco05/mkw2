// DR-13 — the points where an order is taken up again TODAY without a person, and the one state nothing takes up (docs/PROPOSTA-RECUPERO-AUTONOMO-DR13.md, §2–§3).
//
// There is no scheduler, no queue and no resident process: what is autonomous is what the PROVIDER does (a page runs out of its time, and Stripe announces it by webhook). These tests pin
// that down on the faithful stand-in, so that the proposal does not describe a recovery that is not there:
//   RP1  a reservation whose request reached the provider and whose answer was lost, never taken up by the customer: the provider's own announcement that the page expired is carried by the
//        attempt's metadata, so the row receives its identifier and the proof of closing - nobody asked for it;
//   RP2  the twin page of a paid order that could not be closed (the provider did not answer): nothing closes it by itself within the minute, it stays payable and listed - and the provider's
//        own end of the page, announced, writes the proof on the row;
//   RP3  a reservation whose request NEVER reached the provider: no clock, no status read, no webhook of anything else, no sweep of the pages of the order and no listing releases it - 25 hours
//        later it is exactly what it was, the customer is told it is being checked, and the tool finds no evidence (and changes nothing). This is the state that needs a person.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { closePagesOfOrder } from '../../lib/checkout-pages'
import { reconcileAttempt } from '../../lib/checkout-reconcile'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => {
  await k.fresh()
  await k.prisma.adminAuditEvent.deleteMany()
  await k.prisma.user.deleteMany({ where: { email: { endsWith: '@resume.invalid' } } })
})
test.after(async () => { await k.fresh(); await k.prisma.adminAuditEvent.deleteMany(); await k.prisma.user.deleteMany({ where: { email: { endsWith: '@resume.invalid' } } }); await k.sim.close() })

test('RP1: an orphan page that the customer never comes back for - the provider announces its end, and the reservation receives its identifier and the proof, by itself', async () => {
  k.sim.faults.createLostAnswer = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  assert.ok(first.status === 502 || first.status === 503)
  const order = await k.onlyOrder()
  const [reservation] = await k.attemptsOf(order.id)
  assert.equal(reservation.status, 'creating')
  assert.equal(reservation.stripeSessionId, null)
  const [session] = await k.sim.sessionsOf(order.id)
  // nobody comes back; the page runs out of its time at the provider, which says so
  const delivered = await k.expireNaturally(session.id)
  assert.equal(delivered?.status, 200, JSON.stringify(delivered?.json))
  const [row] = await k.attemptsOf(order.id)
  assert.equal(row.stripeSessionId, session.id, 'the identifier is written, from the metadata of the announced session')
  assert.equal(row.status, 'expired')
  assert.match(row.failureReason ?? '', /^provider_status:expired/)
  assert.deepEqual(await k.sim.payable(order.id), [])
  await k.assertClean('RP1')
})

test('RP2: the twin page of a paid order that could not be closed - nothing else closes it by itself; the provider\'s own end of the page writes the proof on the row', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const { twin, sessionId: twinSession } = await k.addLegacyTwin(a.orderId)
  k.sim.faults.expireUnreachable = 50
  const paid = await k.customerPays(a.sessionId)
  assert.equal(paid.delivered?.status, 200, JSON.stringify(paid.delivered?.json))
  k.sim.faults.expireUnreachable = 0
  // the closing failed: the twin is still payable at the provider and still "open" in the database - the report lists it (Q6) and nothing runs by itself to take it up
  assert.deepEqual(await k.sim.payable(a.orderId), [twinSession])
  assert.equal((await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: twin.id } })).status, 'open')
  const q6 = (await k.prisma.$queryRawUnsafe(
    `SELECT a."id" FROM "PaymentAttempt" a JOIN "PrintOrder" o ON o."id" = a."orderId" WHERE a."status" IN ('creating','open') AND a."orderId" = '${a.orderId}' AND (o."paymentStatus" IN ('paid','free','processing') OR o."status" <> 'awaiting_payment' OR o."paymentReviewReason" IS NOT NULL)`)) as Array<{ id: string }>
  assert.deepEqual(q6.map((x) => x.id), [twin.id])
  // the page runs out of its time at the provider, which announces it: the row receives the proof
  const delivered = await k.expireNaturally(twinSession)
  assert.equal(delivered?.status, 200, JSON.stringify(delivered?.json))
  const row = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: twin.id } })
  assert.equal(row.status, 'expired')
  assert.match(row.failureReason ?? '', /^provider_status:expired/)
  assert.deepEqual(await k.sim.payable(a.orderId), [])
})

test('RP3: a reservation whose request never reached the provider is released by NOTHING - not a day, not a status read, not the sweep of the order\'s pages, not an empty listing; the tool finds no evidence and changes nothing', async () => {
  k.sim.faults.createUnreachable = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  assert.ok(first.status === 502 || first.status === 503)
  const order = await k.onlyOrder()
  const [reservation] = await k.attemptsOf(order.id)
  assert.equal(reservation.status, 'creating')
  assert.equal(await k.sim.createdSessions(), 0, 'premise: the provider never heard of it')
  const rowOf = async () => { const r = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: reservation.id } }); return JSON.stringify([r.status, r.stripeSessionId, r.failureReason, r.requestHash, r.expiresAt.toISOString()]) }
  const before = await rowOf()
  await k.travel(25 * k.HOUR)                                     // a day and an hour pass
  await k.getStatus(order.id, { ...first.who, cookie: first.accessCookie ?? undefined })   // a sign of life: the customer looks at the status page
  await closePagesOfOrder(order.id)                               // a sign of life: the sweep of the order's pages
  assert.equal(await rowOf(), before, 'a day and the signs of life that do not bring evidence changed the row')
  // the customer comes back: the request is too old to be sent again, and nothing is opened next to it
  const back = await k.payAgain({ ...first, orderId: order.id })
  assert.equal(back.status, 503, back.text)
  assert.equal(back.json?.code, 'RESERVATION_UNRESOLVED')
  assert.equal(await rowOf(), before)
  assert.equal(await k.sim.createdSessions(), 0)
  // the tool looks for evidence, finds none, and releases nothing
  const admin = await k.prisma.user.create({ data: { email: 'operator@resume.invalid', passwordHash: 'x', role: 'admin', isAdmin: true } })
  const r = await reconcileAttempt({ attemptId: reservation.id, discover: true, operatorId: admin.id, dryRun: false })
  assert.equal(r.outcome, 'no_evidence', r.message)
  assert.equal(await rowOf(), before, 'a complete, empty listing is not proof of absence')
  assert.equal((await k.attemptsOf(order.id)).length, 1, 'and no successor was opened')
})
