// Step 4.6, S6a (P2b) - the FINANCIAL REVISION of an order, proved on the REAL writers (routes, the payment sync, the checkout) and a throw-away database.
//
// An administrator's authorization to produce is valid only while the order still has the revision it had when the authorization was given. That only protects the money if EVERY
// change of a financial fact raises the revision, in the SAME statement, and if nothing else does. This file proves it three ways:
//   1. a DATABASE PROBE (a trigger that exists only while this file runs, in the throw-away database) watches every UPDATE of an order, of a payment attempt and of a refund
//      operation, whichever code made it. It decides on its own - from a hand-written list of the financial facts (E1-E14), not from the application's registry - whether the
//      UPDATE changed one, and compares with what happened to the revision IN THAT SAME UPDATE: raised by exactly one if and only if a financial fact changed (a payment attempt
//      that moves money counts through the order UPDATE of its own transaction);
//   2. one case for each event that has a writer (E1-E14) and one for each change that must NOT count (N1-N10), each through the writer that really does it, each with an authorization
//      recorded before it: after an event the authorization is stale and stays stale when the values come back; after a non-event it is still valid;
//   3. the revision never goes down or back, two writers at the same moment lose no increment, and a rewrite of the metadata (an old copy, forged values, a wrong type, an erased
//      account) can not bring an authorization back to life.
// E6 (the payment method) and E8 (the PayPal proof) have no writer after an order is made, and E13 (a refund operation) has none before the refund work: the probe watches for
// them, and the static guard G11 (tests/production-release-guards.test.ts) covers any writer that appears. No Stripe, PayPal, PrintLab, StockWorks or printer is ever contacted.
import './_harness'
import { db } from './_harness'
import { ORIGIN, as, asKey, bodyOf, callAssign, callStatus, callSubmit, makeOrder, releasedSpec, request, resetSeams, setup, snap, state, teardown, world } from './_release-fixtures'
import { addTwinSession, chargeEvent, decisionOf, deliver, endFlow, flow, freshFlow, initFlow, sessionEvent, startCheckout } from './_s6-flow'
import { authorizationStaleness, getProductionAuthorization } from '../../lib/order-payment-policy'
import { stripePaymentAdminOps } from '../../lib/stripe-payments'
import { updateOrderMetadata } from '../../lib/order-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

// ======================================================================================================================================
// The probe
// ======================================================================================================================================
// What counts as a financial fact is written here AGAIN, by hand, in SQL (the list of the plan: E1-E14), so that the probe can disagree with the application's own registry.
const PROBE_SQL: string[] = [
  `DROP TRIGGER IF EXISTS s6_probe_order ON "PrintOrder"`,
  `DROP TRIGGER IF EXISTS s6_probe_attempt ON "PaymentAttempt"`,
  `DROP TRIGGER IF EXISTS s6_probe_refund ON "RefundOperation"`,
  `DROP TABLE IF EXISTS "S6RevisionProbe"`,
  `CREATE TABLE "S6RevisionProbe" (id bigserial PRIMARY KEY, txid bigint NOT NULL, source text NOT NULL, "orderId" text NOT NULL, financial boolean NOT NULL, delta integer NOT NULL)`,
  `CREATE OR REPLACE FUNCTION s6_probe_order() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     INSERT INTO "S6RevisionProbe"(txid, source, "orderId", financial, delta) VALUES (
       txid_current(), 'order', NEW.id,
       (   NEW."paymentStatus" IS DISTINCT FROM OLD."paymentStatus"
        OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
        OR NEW."paymentReviewReason" IS DISTINCT FROM OLD."paymentReviewReason"
        OR NEW."refundedCents" IS DISTINCT FROM OLD."refundedCents"
        OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents"
        OR NEW."subtotalCents" IS DISTINCT FROM OLD."subtotalCents"
        OR NEW."shippingCents" IS DISTINCT FROM OLD."shippingCents"
        OR NEW."taxCents" IS DISTINCT FROM OLD."taxCents"
        OR NEW."discountPercent" IS DISTINCT FROM OLD."discountPercent"
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW."stripePaymentIntentId" IS DISTINCT FROM OLD."stripePaymentIntentId"
        OR NEW."stripeInvoiceId" IS DISTINCT FROM OLD."stripeInvoiceId"
        OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
        OR ((NEW.status IN ('cancelled', 'canceled')) IS DISTINCT FROM (OLD.status IN ('cancelled', 'canceled')))
        OR (NEW.metadata #> '{stripe,paymentStatus}') IS DISTINCT FROM (OLD.metadata #> '{stripe,paymentStatus}')
        OR (NEW.metadata #> '{stripe,paymentIntentId}') IS DISTINCT FROM (OLD.metadata #> '{stripe,paymentIntentId}')
        OR (NEW.metadata #> '{stripe,dispute}') IS DISTINCT FROM (OLD.metadata #> '{stripe,dispute}')
        OR (NEW.metadata #> '{stripeInvoice,paymentStatus}') IS DISTINCT FROM (OLD.metadata #> '{stripeInvoice,paymentStatus}')
        OR (NEW.metadata #> '{paypal,captureId}') IS DISTINCT FROM (OLD.metadata #> '{paypal,captureId}')
        OR (NEW.metadata #> '{paypal,paymentStatus}') IS DISTINCT FROM (OLD.metadata #> '{paypal,paymentStatus}')
        OR (NEW.metadata -> 'manualPayment') IS DISTINCT FROM (OLD.metadata -> 'manualPayment')
        OR (NEW.metadata -> 'paymentReview') IS DISTINCT FROM (OLD.metadata -> 'paymentReview')
        OR (NEW.metadata -> 'paymentHoldResolution') IS DISTINCT FROM (OLD.metadata -> 'paymentHoldResolution')),
       NEW."financialRevision" - OLD."financialRevision");
     RETURN NEW;
   EXCEPTION WHEN undefined_table THEN RETURN NEW;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION s6_probe_attempt() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE fin boolean;
   BEGIN
     IF TG_OP = 'INSERT' THEN
       fin := false;
     ELSE
       fin := (NEW.status IS DISTINCT FROM OLD.status AND (OLD.status IN ('processing', 'paid', 'mismatch') OR NEW.status IN ('processing', 'paid', 'mismatch')))
           OR NEW."amountReceivedCents" IS DISTINCT FROM OLD."amountReceivedCents"
           OR NEW."stripePaymentIntentId" IS DISTINCT FROM OLD."stripePaymentIntentId";
     END IF;
     INSERT INTO "S6RevisionProbe"(txid, source, "orderId", financial, delta) VALUES (txid_current(), 'attempt', NEW."orderId", fin, 0);
     RETURN NEW;
   EXCEPTION WHEN undefined_table THEN RETURN NEW;
   END $fn$`,
  `CREATE OR REPLACE FUNCTION s6_probe_refund() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE fin boolean;
   BEGIN
     IF TG_OP = 'INSERT' THEN fin := true;
     ELSE fin := NEW.status IS DISTINCT FROM OLD.status OR NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt";
     END IF;
     INSERT INTO "S6RevisionProbe"(txid, source, "orderId", financial, delta) VALUES (txid_current(), 'refund', NEW."orderId", fin, 0);
     RETURN NEW;
   EXCEPTION WHEN undefined_table THEN RETURN NEW;
   END $fn$`,
  `CREATE TRIGGER s6_probe_order AFTER UPDATE ON "PrintOrder" FOR EACH ROW EXECUTE FUNCTION s6_probe_order()`,
  `CREATE TRIGGER s6_probe_attempt AFTER INSERT OR UPDATE ON "PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION s6_probe_attempt()`,
  `CREATE TRIGGER s6_probe_refund AFTER INSERT OR UPDATE ON "RefundOperation" FOR EACH ROW EXECUTE FUNCTION s6_probe_refund()`,
]
const PROBE_REMOVE: string[] = [
  `DROP TRIGGER IF EXISTS s6_probe_order ON "PrintOrder"`,
  `DROP TRIGGER IF EXISTS s6_probe_attempt ON "PaymentAttempt"`,
  `DROP TRIGGER IF EXISTS s6_probe_refund ON "RefundOperation"`,
  `DROP FUNCTION IF EXISTS s6_probe_order()`,
  `DROP FUNCTION IF EXISTS s6_probe_attempt()`,
  `DROP FUNCTION IF EXISTS s6_probe_refund()`,
  `DROP TABLE IF EXISTS "S6RevisionProbe"`,
]
async function runSql(statements: string[]) {
  const prisma = await db()
  for (const statement of statements) await prisma.$executeRawUnsafe(statement)
}
type ProbeRow = { id: number; txid: string; source: 'order' | 'attempt' | 'refund'; orderId: string; financial: boolean; delta: number }
const probeMark = async () => Number(((await (await db()).$queryRawUnsafe(`SELECT COALESCE(MAX(id), 0)::int AS m FROM "S6RevisionProbe"`)) as Array<{ m: number }>)[0].m)
async function probeSince(mark: number): Promise<ProbeRow[]> {
  const rows = (await (await db()).$queryRawUnsafe(`SELECT id::int AS id, txid::text AS txid, source, "orderId", financial, delta FROM "S6RevisionProbe" WHERE id > ${mark} ORDER BY id`)) as ProbeRow[]
  return rows
}
// The rule: in every transaction, for every order, each UPDATE of the order raised the revision by one if it changed a financial fact itself, and otherwise by zero - or by one when
// a payment attempt / refund operation of that order moved money in the same transaction (then at least one of the order's UPDATEs carried the increment).
function assertProbe(rows: ProbeRow[], label: string) {
  const groups = new Map<string, ProbeRow[]>()
  for (const row of rows) groups.set(`${row.txid}/${row.orderId}`, [...(groups.get(`${row.txid}/${row.orderId}`) ?? []), row])
  let orderUpdates = 0
  for (const [key, group] of groups) {
    const updates = group.filter((row) => row.source === 'order')
    const signals = group.filter((row) => row.source !== 'order' && row.financial).length
    for (const update of updates) {
      orderUpdates++
      assert.ok(update.delta === 0 || update.delta === 1, `${label} (${key}): an UPDATE of the order raised the revision by ${update.delta}`)
      if (update.financial) assert.equal(update.delta, 1, `${label} (${key}): a financial fact of the order changed and the revision did NOT go up in the same UPDATE`)
      else if (update.delta === 1) assert.ok(signals > 0, `${label} (${key}): the revision went up in an UPDATE that changed no financial fact (and no attempt or refund operation moved money in the transaction)`)
    }
    if (signals > 0) assert.ok(updates.reduce((sum, update) => sum + update.delta, 0) >= 1, `${label} (${key}): a payment attempt / refund operation moved money and the order's revision did not go up in that transaction`)
  }
  return orderUpdates
}

// ======================================================================================================================================
// set-up
// ======================================================================================================================================
test.before(async () => {
  await setup()
  await initFlow({ reset: false })
  await runSql(PROBE_SQL)
})
test.after(async () => {
  await runSql(PROBE_REMOVE)
  endFlow()
  await teardown()
})
test.beforeEach(async () => {
  resetSeams()
  await freshFlow()
  await world()
  asKey('admin')
})

const REASON = 'agreed with the customer on the phone'
const revisionOf = async (orderId: string) => (await (await db()).printOrder.findUniqueOrThrow({ where: { id: orderId }, select: { financialRevision: true } })).financialRevision

// an authorization recorded at the revision the order has NOW - what checkManualTransition writes (the route refuses to grant one while a payment page is open, so the case writes it)
async function authorizeNow(orderId: string) {
  const prisma = await db()
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
  await prisma.printOrder.update({
    where: { id: orderId },
    data: { metadata: { ...(row.metadata as object), productionAuthorization: { authorized: true, by: state.adminId, at: new Date().toISOString(), reason: REASON, kind: 'exceptional', financialRevision: row.financialRevision } } as any },
  })
  return row.financialRevision
}
async function stalenessOf(orderId: string) {
  const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: orderId } })
  const authorization = getProductionAuthorization(row.metadata)
  assert.ok(authorization, 'the writer erased the authorization as a side effect')
  return authorizationStaleness(authorization, row.financialRevision)
}

// ---- the writers ----------------------------------------------------------------------------------------------------------------------
const callHold = async (orderId: string, outcome: 'accepted' | 'no_charge') => {
  const { POST } = await import('../../app/api/admin/orders/[orderId]/payment-hold/route')
  return (POST as any)(request(`/api/admin/orders/${orderId}/payment-hold`, 'POST', { outcome, reason: 'checked with the bank this morning' }), { params: Promise.resolve({ orderId }) }) as Promise<Response>
}
const callItem = async (orderId: string, itemId: string, body: Record<string, unknown>) => {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/items/[itemId]/route')
  return (PATCH as any)(request(`/api/admin/orders/${orderId}/items/${itemId}`, 'PATCH', body), { params: Promise.resolve({ orderId, itemId }) }) as Promise<Response>
}
const callShipping = async (orderId: string, body: Record<string, unknown>) => {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/shipping/route')
  return (PATCH as any)(request(`/api/admin/orders/${orderId}/shipping`, 'PATCH', body), { params: Promise.resolve({ orderId }) }) as Promise<Response>
}
const callAttach = async (orderId: string, body: Record<string, unknown>) => {
  const { POST } = await import('../../app/api/admin/orders/[orderId]/stripe-attach/route')
  return (POST as any)(request(`/api/admin/orders/${orderId}/stripe-attach`, 'POST', body), { params: Promise.resolve({ orderId }) }) as Promise<Response>
}
const patchJob = async (paymentIntentId: string, body: Record<string, unknown>) => {
  const { PATCH } = await import('../../app/api/jobs/[paymentIntentId]/route')
  const res = (await (PATCH as any)(new NextRequest(`${ORIGIN}/api/jobs/${paymentIntentId}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) }), { params: Promise.resolve({ paymentIntentId }) })) as Response
  return { res, json: await bodyOf(res) }
}
async function orgFixture() {
  const prisma = await db()
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const [approver, requester] = await Promise.all(['approver', 'requester'].map((name) => prisma.user.create({ data: { email: `rev-${name}-${stamp}@sectest.invalid`, passwordHash: 'x', name, role: 'customer' } as any })))
  const org = await prisma.organization.create({ data: { name: `Org ${stamp}`, slug: `org-${stamp}`, createdById: approver.id } })
  await prisma.organizationMember.createMany({ data: [{ organizationId: org.id, userId: approver.id, role: 'approver' }, { organizationId: org.id, userId: requester.id, role: 'requester' }] })
  return { org, approver }
}
async function callApproval(orgId: string, orderId: string, action: 'approve' | 'reject', viewerId: string) {
  as({ id: viewerId, role: 'customer' })
  const { POST } = await import('../../app/api/customer/organizations/[organizationId]/orders/[orderId]/approval/route')
  return (POST as any)(new NextRequest(`${ORIGIN}/api/customer/organizations/${orgId}/orders/${orderId}/approval`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ action, note: 'looks right' }) }), { params: Promise.resolve({ organizationId: orgId, orderId }) }) as Promise<Response>
}
const unpaid = async (over: Parameters<typeof makeOrder>[0] = {}) => {
  const order = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending', total: 3000, ...over })
  await (await db()).printOrder.update({ where: { id: order.id }, data: { paymentMethod: 'cash' } })
  return order
}
// the hosted checkout, paid and recorded by the payment sync (what a verified payment looks like)
async function paidByTheSync() {
  const started = await startCheckout()
  const { piId } = flow.fake.pay(started.sessionId)
  assert.equal((await deliver(sessionEvent('checkout.session.completed', started.sessionId))).status, 200)
  return { ...started, piId }
}

// ======================================================================================================================================
// 1 + 2. One case per event and per non-event, through the real writer
// ======================================================================================================================================
type Ctx = { orderId: string } & Record<string, any>
type Case = { id: string; label: string; prepare: () => Promise<Ctx>; act: (ctx: Ctx) => Promise<void> }

const EVENTS: Case[] = [
  {
    id: 'E1', label: 'the payment sync records a verified payment (payment status, payment date, Stripe proof, the attempt becomes paid)',
    prepare: async () => ({ ...(await startCheckout()) }),
    act: async (ctx) => { flow.fake.pay(ctx.sessionId); assert.equal((await deliver(sessionEvent('checkout.session.completed', ctx.sessionId))).status, 200) },
  },
  {
    id: 'E1/E12', label: 'the payment sync sees a payment that is still being confirmed (payment status and attempt go to processing)',
    prepare: async () => ({ ...(await startCheckout()) }),
    act: async (ctx) => { flow.fake.pay(ctx.sessionId, { piStatus: 'processing', paymentStatus: 'unpaid' }); assert.equal((await deliver(sessionEvent('checkout.session.completed', ctx.sessionId))).status, 200) },
  },
  {
    id: 'E3', label: 'the payment sync reads a refund of the order\'s payment (the refunded amount)',
    prepare: async () => ({ ...(await paidByTheSync()) }),
    act: async (ctx) => { flow.fake.intents.get(ctx.piId)!.latest_charge.amount_refunded = 500; assert.equal((await deliver(chargeEvent('charge.refunded', ctx.piId))).status, 200) },
  },
  {
    id: 'E2/E7/E10', label: 'the payment sync reads a dispute (the review reason, the Stripe proof, the review log)',
    prepare: async () => ({ ...(await paidByTheSync()) }),
    act: async (ctx) => { flow.fake.intents.get(ctx.piId)!.latest_charge.disputed = true; assert.equal((await deliver(chargeEvent('charge.dispute.created', ctx.piId))).status, 200) },
  },
  {
    id: 'E2/E10/E12', label: 'the payment sync reads a SECOND paid page for an order already paid (a duplicate: review reason, log, the attempt)',
    prepare: async () => {
      const first = await paidByTheSync()
      await addTwinSession(first.orderId, first.total, 'cs_test_S6_REV_TWIN')
      flow.fake.pay('cs_test_S6_REV_TWIN')
      return { ...first }
    },
    act: async () => { assert.equal((await deliver(sessionEvent('checkout.session.completed', 'cs_test_S6_REV_TWIN'))).status, 200) },
  },
  {
    id: 'E12', label: 'a customer comes back to a payment page that is already complete at Stripe: the attempt becomes "processing" (checkout, no order UPDATE of its own before S6)',
    prepare: async () => {
      const started = await startCheckout()
      flow.fake.pay(started.sessionId, { piStatus: 'processing', paymentStatus: 'unpaid' }) // paid at Stripe; no webhook has arrived yet
      return { ...started }
    },
    act: async (ctx) => {
      const { openCheckoutSession } = await import('../../lib/checkout-sessions')
      const opened = await openCheckoutSession({ orderId: ctx.orderId, returnBaseUrl: 'http://localhost' })
      assert.equal(opened.kind, 'blocked', 'a payment that finished at Stripe must not open a second page')
      assert.equal((await (await db()).paymentAttempt.findUniqueOrThrow({ where: { id: ctx.attemptId } })).status, 'processing')
    },
  },
  {
    id: 'E2/E11', label: 'an administrator ACCEPTS a payment on hold (the review reason goes, a resolution entry is added)',
    prepare: async () => ({ orderId: (await makeOrder(releasedSpec({ reason: 'duplicate_payment', attempts: ['paid', 'mismatch'] }))).id }),
    act: async (ctx) => { const res = await callHold(ctx.orderId, 'accepted'); assert.equal(res.status, 200, JSON.stringify(await bodyOf(res))) },
  },
  {
    id: 'E1/E2/E12/E14', label: 'an administrator resolves a hold as "no charge" (the order is cancelled, its payment status and attempts close)',
    prepare: async () => {
      const started = await startCheckout()
      const prisma = await db()
      await prisma.printOrder.update({ where: { id: started.orderId }, data: { paymentReviewReason: 'amount' } })
      await prisma.paymentAttempt.update({ where: { id: started.attemptId }, data: { status: 'mismatch' } })
      return { ...started }
    },
    act: async (ctx) => { const res = await callHold(ctx.orderId, 'no_charge'); assert.equal(res.status, 200, JSON.stringify(await bodyOf(res))) },
  },
  {
    id: 'E4', label: 'an administrator changes a quantity (the totals)',
    prepare: async () => ({ orderId: (await unpaid()).id }),
    act: async (ctx) => {
      const item = await (await db()).printOrderItem.findFirstOrThrow({ where: { orderId: ctx.orderId } })
      const res = await callItem(ctx.orderId, item.id, { quantity: 3, reason: 'the customer asked for two more of them' })
      assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
    },
  },
  {
    id: 'E5', label: 'an administrator links a Stripe payment that names the order (the PaymentIntent)',
    prepare: async () => ({ orderId: (await unpaid({ total: 4500 })).id }),
    act: async (ctx) => {
      const original = { ...stripePaymentAdminOps }
      stripePaymentAdminOps.retrievePaymentIntent = (async () => ({ id: 'pi_revattach1', object: 'payment_intent', status: 'succeeded', amount: 4500, amount_received: 4500, currency: 'eur', metadata: { orderId: ctx.orderId }, customer: 'cus_1', receipt_email: 'buyer@example.com' })) as any
      stripePaymentAdminOps.syncStripePaymentIntent = (async () => ({ paymentStatus: 'pending', updatedOrders: 0, orderIds: [] })) as any
      try {
        const res = await callAttach(ctx.orderId, { paymentIntentId: 'pi_revattach1', reason: 'the buyer paid from the e-mailed link' })
        assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
      } finally { Object.assign(stripePaymentAdminOps, original) }
    },
  },
  {
    id: 'E1/E9', label: 'an administrator attests a payment received outside Stripe, on an order that already exists (payment status and the receipt record)',
    prepare: async () => {
      const id = `cash_rev_${Date.now()}`
      const prisma = await db()
      const job = await prisma.jobForm.create({
        data: { paymentIntentId: id, totalCents: 9000, currency: 'EUR', status: 'pending', paymentMethod: 'cash', paymentStatus: 'pending', lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 90, lineTotal: 90, material: 'PLA' }], shipping: { method: 'pickup' } } as any,
      })
      const order = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending', total: 9000 }, { metadata: { paymentIntentId: id, jobFormId: job.id, source: 'orderworks' } })
      await prisma.printOrder.update({ where: { id: order.id }, data: { paymentMethod: 'cash' } })
      return { orderId: order.id, jobId: id }
    },
    act: async (ctx) => { const { res, json } = await patchJob(ctx.jobId, { paymentStatus: 'paid', receivedVia: 'cash', reason: REASON }); assert.equal(res.status, 200, JSON.stringify(json)) },
  },
  {
    id: 'E14', label: 'an administrator cancels an order',
    prepare: async () => ({ orderId: (await unpaid()).id }),
    act: async (ctx) => { const res = await callStatus(ctx.orderId, 'cancelled'); assert.equal(res.status, 200, JSON.stringify(await bodyOf(res))) },
  },
  {
    id: 'E14', label: 'an administrator moves a cancelled order out of "cancelled" (the status route has no "awaiting payment": the order goes to "failed")',
    prepare: async () => ({ orderId: (await unpaid({ status: 'cancelled' })).id }),
    act: async (ctx) => { const res = await callStatus(ctx.orderId, 'failed'); assert.equal(res.status, 200, JSON.stringify(await bodyOf(res))) },
  },
  {
    id: 'E14', label: 'an organization approver rejects a quote that has no money on it (the order is cancelled)',
    prepare: async () => {
      const f = await orgFixture()
      const order = await makeOrder({ name: 'quote', status: 'awaiting_review', paymentStatus: 'quote' })
      await (await db()).printOrder.update({ where: { id: order.id }, data: { organizationId: f.org.id } })
      return { orderId: order.id, org: f.org, approver: f.approver }
    },
    act: async (ctx) => { const res = await callApproval(ctx.org.id, ctx.orderId, 'reject', ctx.approver.id); assert.equal(res.status, 200, JSON.stringify(await bodyOf(res))); asKey('admin') },
  },
]

const NON_EVENTS_CASES: Case[] = [
  {
    id: 'N1', label: 'the receipt link and status are saved on the order (receiptUrl, receiptStatus)',
    prepare: async () => ({ orderId: (await unpaid()).id }),
    act: async (ctx) => { await updateOrderMetadata(ctx.orderId, (metadata) => ({ metadata, columns: { receiptUrl: 'https://example.test/receipt.pdf', receiptStatus: 'received' }, result: null })) },
  },
  {
    id: 'N2', label: 'the payment sync runs again on a payment it already recorded (the lease, the synchronisation time)',
    prepare: async () => ({ ...(await paidByTheSync()) }),
    act: async (ctx) => { assert.equal((await deliver(sessionEvent('checkout.session.completed', ctx.sessionId))).status, 200) },
  },
  {
    id: 'N3', label: 'a SECOND payment page of the order expires without money (availability of a page, not a financial fact)',
    prepare: async () => {
      const started = await startCheckout()
      await addTwinSession(started.orderId, started.total, 'cs_test_S6_REV_N3')
      return { ...started }
    },
    act: async () => {
      flow.fake.sessions.get('cs_test_S6_REV_N3')!.status = 'expired'
      assert.equal((await deliver(sessionEvent('checkout.session.expired', 'cs_test_S6_REV_N3'))).status, 200)
    },
  },
  {
    id: 'N4', label: 'production moves: a printer is assigned and the order is moved through production',
    prepare: async () => {
      const printer = await (await db()).printer.create({ data: { name: 'FAKE A1 mini' } })
      return { orderId: (await makeOrder(releasedSpec())).id, printerId: printer.id }
    },
    act: async (ctx) => {
      assert.equal((await callAssign(ctx.orderId, ctx.printerId)).status, 200)
      assert.equal((await callStatus(ctx.orderId, 'printing')).status, 200)
      assert.equal((await callStatus(ctx.orderId, 'completed')).status, 200)
    },
  },
  {
    id: 'N5', label: 'the order is sent to PrintLab (the production markers in the metadata)',
    prepare: async () => ({ orderId: (await makeOrder(releasedSpec())).id }),
    act: async (ctx) => { const res = await callSubmit(ctx.orderId); assert.equal(res.status, 200, JSON.stringify(await bodyOf(res))) },
  },
  {
    id: 'N6', label: 'an organization approver approves a paid order (the approval record; the order goes to the queue)',
    prepare: async () => {
      const f = await orgFixture()
      const order = await makeOrder(releasedSpec({ status: 'awaiting_review' }))
      await (await db()).printOrder.update({ where: { id: order.id }, data: { organizationId: f.org.id } })
      return { orderId: order.id, org: f.org, approver: f.approver }
    },
    act: async (ctx) => { const res = await callApproval(ctx.org.id, ctx.orderId, 'approve', ctx.approver.id); assert.equal(res.status, 200, JSON.stringify(await bodyOf(res))); asKey('admin') },
  },
  {
    id: 'N8', label: 'an administrator saves the shipping information (carrier, tracking)',
    prepare: async () => ({ orderId: (await unpaid()).id }),
    act: async (ctx) => { const res = await callShipping(ctx.orderId, { carrier: 'DHL', trackingNumber: 'TRK-123' }); assert.equal(res.status, 200, JSON.stringify(await bodyOf(res))) },
  },
]

async function runCase(c: Case, expectation: 'raises' | 'keeps') {
  const ctx = await c.prepare()
  const revisionAtGrant = await authorizeNow(ctx.orderId)
  const before = await revisionOf(ctx.orderId)
  assert.equal(before, revisionAtGrant, 'the authorization was recorded at the order\'s revision')
  asKey('admin') // (a case that starts a checkout leaves the request as a guest's)
  const mark = await probeMark()
  await c.act(ctx)
  const rows = await probeSince(mark)
  const updates = assertProbe(rows, `${c.id} ${c.label}`)
  assert.ok(updates > 0, `${c.id}: the writer did not UPDATE an order at all (the case proves nothing)`)
  const after = await revisionOf(ctx.orderId)
  if (expectation === 'raises') {
    assert.ok(after > before, `${c.id} ${c.label}: the financial revision did not go up (${before} -> ${after})`)
    assert.equal(await stalenessOf(ctx.orderId), 'revision_changed', `${c.id}: the authorization given before it is still valid`)
  } else {
    assert.equal(after, before, `${c.id} ${c.label}: the revision went up (${before} -> ${after}) for a change that is not a financial fact`)
    assert.equal(await stalenessOf(ctx.orderId), null, `${c.id}: the authorization given before it was invalidated by a change that is not a financial fact`)
  }
  return ctx
}

for (const c of EVENTS) {
  test(`${c.id} ${c.label}: the revision goes up in the same UPDATE, and an authorization given before is stale`, async () => { await runCase(c, 'raises') })
}
for (const c of NON_EVENTS_CASES) {
  test(`${c.id} ${c.label}: the revision does not move, and an authorization given before stays valid`, async () => { await runCase(c, 'keeps') })
}

test('N10 granting an authorization does not change the revision: it records the revision the order has', async () => {
  const order = await unpaid()
  const before = await revisionOf(order.id)
  const mark = await probeMark()
  const res = await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationReason: REASON })
  assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
  assertProbe(await probeSince(mark), 'N10')
  const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(row.financialRevision, before)
  assert.equal(getProductionAuthorization(row.metadata)?.financialRevision, before)
  assert.equal((await decisionOf(order.id)).basis, 'admin_authorization')
})

// the events that have no writer of their own: the application must not have grown one without the probe being able to see it
test('E6 / E8: no writer changes the payment method or the PayPal proof of an order that exists - and the probe can SEE such a change, so a writer that appears can not hide', async () => {
  const order = await unpaid()
  // a writer that changed them would show up in the probe like any other; here the probe is proved able to SEE each of them (a direct write, by the test, standing in for a writer)
  const prisma = await db()
  for (const [label, data] of [
    ['E6 the payment method', { paymentMethod: 'card' }],
    ['E8 the PayPal proof', { metadata: { paypal: { captureId: 'cap_1', paymentStatus: 'paid' } } }],
  ] as const) {
    const mark = await probeMark()
    await prisma.printOrder.update({ where: { id: order.id }, data: data as any })
    const rows = await probeSince(mark)
    assert.equal(rows.length, 1, label)
    assert.equal(rows[0].financial, true, `${label}: the probe does not see it as a financial change`)
    assert.equal(rows[0].delta, 0, `${label}: nothing but a writer that uses withFinancialRevision raises the revision (a bare write does not)`)
    assert.throws(() => assertProbe(rows, label), /did NOT go up/, `${label}: the probe would not catch a writer that forgot the revision`)
  }
})

test('the probe itself: it fails on a financial change that forgot the revision, on a revision raised for nothing, and on money that moved on an attempt with no order UPDATE', async () => {
  const order = await unpaid()
  const prisma = await db()
  // (a) a bare write of a financial fact: the revision does not move
  let mark = await probeMark()
  await prisma.printOrder.update({ where: { id: order.id }, data: { totalCents: 3100 } })
  let rows = await probeSince(mark)
  assert.throws(() => assertProbe(rows, 'a'), /did NOT go up/)
  // (b) the revision raised with no financial change at all
  mark = await probeMark()
  await prisma.printOrder.update({ where: { id: order.id }, data: { financialRevision: { increment: 1 }, notes: 'nothing financial here' } })
  rows = await probeSince(mark)
  assert.throws(() => assertProbe(rows, 'b'), /changed no financial fact/)
  // (c) a payment attempt moves money and the order is not updated in the transaction
  const attempt = await prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: 3100, currency: 'EUR', status: 'open', expiresAt: new Date(Date.now() + 60_000) } })
  mark = await probeMark()
  await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'processing' } })
  rows = await probeSince(mark)
  assert.throws(() => assertProbe(rows, 'c'), /moved money and the order's revision did not go up/)
  // (d) a page that only expires is not a financial move
  const page = await prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: 3100, currency: 'EUR', status: 'open', expiresAt: new Date(Date.now() + 60_000) } })
  mark = await probeMark()
  await prisma.paymentAttempt.update({ where: { id: page.id }, data: { status: 'expired' } })
  rows = await probeSince(mark)
  assert.doesNotThrow(() => assertProbe(rows, 'd'))
})

// ======================================================================================================================================
// 3. The revision only goes up, and nothing brings an old authorization back
// ======================================================================================================================================
test('M96 two writers at the same moment lose no increment: three financial writes, three increments', async () => {
  const order = await unpaid({ items: 2, total: 4000 })
  const items = await (await db()).printOrderItem.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } })
  const job = `cash_rev_conc_${Date.now()}`
  const prisma = await db()
  await prisma.jobForm.create({ data: { paymentIntentId: job, totalCents: 4000, currency: 'EUR', status: 'pending', paymentMethod: 'cash', paymentStatus: 'pending', lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 40, lineTotal: 40, material: 'PLA' }], shipping: { method: 'pickup' } } as any })
  await prisma.printOrder.update({ where: { id: order.id }, data: { metadata: { ...((await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).metadata as object), paymentIntentId: job, source: 'orderworks' } } })
  const before = await revisionOf(order.id)
  const mark = await probeMark()
  const results = await Promise.all([
    callItem(order.id, items[0].id, { quantity: 2, reason: 'the customer asked for two of the first part' }),
    callItem(order.id, items[1].id, { quantity: 3, reason: 'the customer asked for three of the second part' }),
    patchJob(job, { paymentStatus: 'paid', receivedVia: 'cash', reason: REASON }).then(({ res }) => res),
  ])
  const ok = results.filter((res) => res.status === 200).length
  assert.equal(ok, 3, `a writer was refused: ${(await Promise.all(results.map((res) => res.status))).join(', ')}`)
  assertProbe(await probeSince(mark), 'M96')
  assert.equal(await revisionOf(order.id), before + 3, 'an increment was lost: two writers read the same revision and wrote the same value')
})

test('M96 the revision does not come back down: values that return do not bring an old authorization back (refunded then not, a total changed then restored)', async () => {
  const order = await unpaid({ total: 3000 })
  const prisma = await db()
  const grantedAt = await authorizeNow(order.id)
  const item = await prisma.printOrderItem.findFirstOrThrow({ where: { orderId: order.id } })
  assert.equal((await callItem(order.id, item.id, { quantity: 3, reason: 'the customer asked for two more of them' })).status, 200)
  assert.equal(await stalenessOf(order.id), 'revision_changed')
  const after = await revisionOf(order.id)
  assert.ok(after > grantedAt)
  // the total goes back to what it was when the authorization was given (a direct write, the way a restore or a mistake would)
  await prisma.printOrder.update({ where: { id: order.id }, data: { totalCents: 3000, subtotalCents: 3000 } })
  assert.equal(await revisionOf(order.id), after, 'a bare write does not touch the revision')
  assert.equal(await stalenessOf(order.id), 'revision_changed', 'the old authorization is valid again because the total is back: the A-B-A problem')
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false)
  assert.equal(decision.authorizationStale, 'revision_changed')
  assert.equal((await callAssign(order.id, (await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })).id)).status, 409)
})

// ======================================================================================================================================
// M114 - a rewrite of the metadata must never bring an authorization back to life
// ======================================================================================================================================
test('M114a an old copy of the metadata (a reader-modify-writer that read before the change) put back: the authorization is still stale, because the revision is a COLUMN', async () => {
  const order = await unpaid({ total: 3000 })
  const prisma = await db()
  const granted = await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationReason: REASON })
  assert.equal(granted.status, 200, JSON.stringify(await bodyOf(granted)))
  const copy = (await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).metadata
  // a financial event: the total changes
  const item = await prisma.printOrderItem.findFirstOrThrow({ where: { orderId: order.id } })
  assert.equal((await callItem(order.id, item.id, { quantity: 3, reason: 'the customer asked for two more of them' })).status, 200)
  assert.equal((await decisionOf(order.id)).released, false)
  // the old copy (with the authorization as it was) is written back
  await prisma.printOrder.update({ where: { id: order.id }, data: { metadata: copy as any } })
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false, 'an old copy of the metadata released the order')
  assert.equal(decision.authorizationStale, 'revision_changed')
})

test('M114b an outside sender\'s metadata naming the authorization, the revision or the proofs is dropped: the order is made unpaid and unauthorized', async () => {
  const { createOrderFromJobForm } = await import('../../lib/orders')
  const prisma = await db()
  const id = `ow_rev_${Date.now()}`
  const job = await prisma.jobForm.create({
    data: {
      paymentIntentId: id, totalCents: 4000, currency: 'EUR', status: 'pending', paymentMethod: 'card', paymentStatus: 'pending',
      lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 40, lineTotal: 40, material: 'PLA' }], shipping: { method: 'pickup' },
      metadata: {
        productionAuthorization: { authorized: true, by: 'forged', at: new Date().toISOString(), reason: 'forged by the sender', kind: 'exceptional', financialRevision: 0 },
        financialRevision: 0, stripe: { paymentIntentId: 'pi_forged', paymentStatus: 'paid' }, manualPayment: { by: 'forged', method: 'cash' }, paymentReview: [], paymentHoldResolution: [{ outcome: 'accepted' }],
      },
    } as any,
  })
  const order = (await createOrderFromJobForm(job, { trusted: false }))!
  const metadata = order.metadata as Record<string, any>
  for (const key of ['productionAuthorization', 'financialRevision', 'stripe', 'manualPayment', 'paymentHoldResolution']) assert.equal(metadata[key], undefined, `the sender set "${key}"`)
  assert.equal(order.financialRevision, 0)
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false)
  assert.equal(getProductionAuthorization(metadata), null)
})

for (const [label, value] of [['a string', '0'], ['a decimal', 0.5], ['negative', -1], ['null', null], ['a boolean', true], ['text', 'abc'], ['an object', { n: 0 }]] as const) {
  test(`M114c an authorization whose revision is ${label} is "no revision": it releases nothing and the route refuses`, async () => {
    const order = await unpaid()
    const prisma = await db()
    const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
    await prisma.printOrder.update({
      where: { id: order.id },
      data: { metadata: { ...(row.metadata as object), productionAuthorization: { authorized: true, by: state.adminId, at: new Date().toISOString(), reason: REASON, kind: 'exceptional', financialRevision: value } } as any },
    })
    const decision = await decisionOf(order.id)
    assert.equal(decision.released, false)
    assert.equal(decision.authorizationStale, 'no_revision')
    const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
    const before = await snap(order.id)
    assert.equal((await callAssign(order.id, printer.id)).status, 409)
    assert.deepEqual((await snap(order.id)).row, before.row)
  })
}

test('M114d an erased account takes the metadata - and the authorization - with it, and leaves the revision column alone', async () => {
  const { deleteUserPrivacyData } = await import('../../lib/privacy')
  const prisma = await db()
  const user = await prisma.user.create({ data: { email: `erased-${Date.now()}@sectest.invalid`, passwordHash: 'x', name: 'erased', role: 'customer' } as any })
  const order = await unpaid()
  await prisma.printOrder.update({ where: { id: order.id }, data: { userId: user.id } })
  await authorizeNow(order.id)
  const item = await prisma.printOrderItem.findFirstOrThrow({ where: { orderId: order.id } })
  assert.equal((await callItem(order.id, item.id, { quantity: 2, reason: 'the customer asked for one more of it' })).status, 200)
  const before = await revisionOf(order.id)
  assert.ok(before > 0)
  await deleteUserPrivacyData(user.id)
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(row.metadata, null, 'the metadata is erased')
  assert.equal(getProductionAuthorization(row.metadata), null)
  assert.equal(row.financialRevision, before, 'the erasure does not touch the revision (it holds no personal data) and never lowers it')
  assert.equal((await decisionOf(order.id)).released, false)
})

test('M114e updateOrderMetadata raises the revision itself when a financial key changes, and not for any other key or for the same value written again', async () => {
  const order = await unpaid()
  const mark = await probeMark()
  const base = await revisionOf(order.id)
  await updateOrderMetadata(order.id, (metadata) => ({ metadata: { ...metadata, slicerStats: { grams: 20 } }, result: null }))
  assert.equal(await revisionOf(order.id), base, 'a key that is not a financial fact')
  await updateOrderMetadata(order.id, (metadata) => ({ metadata: { ...metadata, paymentReview: [{ reason: 'amount', at: '2026-10-20T10:00:00.000Z' }] }, result: null }))
  assert.equal(await revisionOf(order.id), base + 1, 'a new entry in the payment review log')
  await updateOrderMetadata(order.id, (metadata) => ({ metadata: { ...metadata, paymentReview: [{ reason: 'amount', at: '2026-10-20T10:00:00.000Z' }] }, result: null }))
  assert.equal(await revisionOf(order.id), base + 1, 'the same value written again is not a change')
  await updateOrderMetadata(order.id, (metadata) => ({ metadata: { ...metadata, manualPayment: { by: state.adminId, at: '2026-10-20T10:00:00.000Z', method: 'cash', receivedVia: 'cash', amountCents: 3000, currency: 'EUR' } }, result: null }))
  assert.equal(await revisionOf(order.id), base + 2, 'a payment record')
  assertProbe(await probeSince(mark), 'M114e')
})
