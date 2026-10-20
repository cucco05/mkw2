// Seeds a THROW-AWAY test database for tests/e2e/production-release.responsive.spec.ts (step 4.6, S4): orders in every situation the production-release screens
// describe (not paid, being confirmed, payment page open, payment under review, an outside order nobody checked, released by a verified payment / a manual
// payment / an administrator's authorization / a commercial credit, paid but not moved yet, sent to production, an outside call whose outcome is unknown, a refund under way,
// a refund already made, an authorization that the money outlived), a customer who owns them,
// an administrator and a staff member, and a session token for each.
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest E2E_RELEASE_FIXTURE=/tmp/release-fixture.json node --import tsx tests/e2e/seed-production-release.ts
// The server under test must run with the same JWT_SECRET as the test harness ('sectest-jwt-secret-0123456789abcdefghijklmnop'). The tokens go to the fixture
// file, never to the terminal. Refuses to run on anything but a local `*_sectest` database (tests/security/_harness.ts). It contacts no outside service.
import { db } from '../security/_harness'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const jwt = createRequire(`${process.cwd()}/package.json`)('jsonwebtoken')
const sign = (id: string) => jwt.sign({ sub: id }, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '1d' })

;(async () => {
  const out = process.env.E2E_RELEASE_FIXTURE
  if (!out) throw new Error('E2E_RELEASE_FIXTURE (path of the fixture file) is required')
  const prisma = await db()
  const upsertUser = async (email: string, name: string, role: string) =>
    (await prisma.user.findUnique({ where: { email } })) ?? prisma.user.create({ data: { email, passwordHash: 'x', name, role, isAdmin: role === 'admin' } as any })
  const customer = await upsertUser('e2e-rel-customer@sectest.invalid', 'E2E Release Customer', 'customer')
  const admin = await upsertUser('e2e-rel-admin@sectest.invalid', 'E2E Release Admin', 'admin')
  const staff = await upsertUser('e2e-rel-staff@sectest.invalid', 'E2E Release Staff', 'staff')
  // (step 4.6, S6) an order that has refund operations can not be deleted (ON DELETE RESTRICT): the ones this seed made on an earlier run go first
  await prisma.refundOperation.deleteMany({ where: { order: { userId: customer.id } } })
  await prisma.printOrder.deleteMany({ where: { userId: customer.id } })
  const printer = (await prisma.printer.findFirst({ where: { name: 'E2E release printer' } }))
    ?? await prisma.printer.create({ data: { name: 'E2E release printer', dailyCapacityHours: 20 } })

  const now = new Date()
  const hourLater = new Date(now.getTime() + 60 * 60 * 1000)
  const at = now.toISOString()
  const stripeProof = (pi: string) => ({
    paymentStatus: 'paid', paymentMethod: 'card', stripePaymentIntentId: pi, paidAt: now,
    paymentAttempts: { create: [{ amountCents: 2500, currency: 'EUR', status: 'paid', expiresAt: hourLater, amountReceivedCents: 2500 }] },
  })
  const stripeMeta = (pi: string) => ({ stripe: { paymentIntentId: pi, paymentStatus: 'paid' } })
  const effect = (kind: string, state: string, extra: Record<string, unknown> = {}) => ({
    kind, state, intentId: `intent_${state}`, attempts: 1, startedAt: at, claimUntil: null, by: 'admin-submit', adminId: admin.id, detail: {},
    externalId: null, confirmedBy: null, cause: null, httpStatus: null, message: null, at, blockedAfterSend: false, ...extra,
  })

  const make = async (key: string, data: Record<string, unknown>, title = 'Vaso con un nome abbastanza lungo da andare a capo') => {
    const order = await prisma.printOrder.create({
      data: {
        userId: customer.id, customerEmail: 'e2e-rel@sectest.invalid', customerName: 'E2E Release Customer', shippingMethod: 'pickup', currency: 'EUR',
        subtotalCents: 2500, totalCents: 2500, paymentMethod: 'card',
        items: { create: [{ modelTitle: title, material: 'PLA', quantity: 1, unitPriceCents: 2500, totalCents: 2500 }] },
        ...data,
      } as any,
      select: { id: true, orderNumber: true, userId: true },
    })
    return [key, order] as const
  }

  const entries = [
    // ---- held back ----
    await make('pending', { status: 'awaiting_payment', paymentStatus: 'pending' }),
    await make('dispute', {
      status: 'queued', paymentReviewReason: 'dispute', ...stripeProof('pi_e2e_dispute'),
      metadata: {
        ...stripeMeta('pi_e2e_dispute'),
        printLabSubmissions: [{ printLabJobId: 'pl_e2e_1', status: 'queued' }],
        lastPrintLabSubmission: { status: 'started', printLabJobId: 'pl_e2e_1', printerName: 'E2E release printer' },
      },
    }),
    await make('processing', { status: 'awaiting_payment', paymentStatus: 'processing', paymentAttempts: { create: [{ amountCents: 2500, currency: 'EUR', status: 'processing', expiresAt: hourLater }] } }),
    await make('openPage', { status: 'awaiting_payment', paymentStatus: 'pending', paymentAttempts: { create: [{ amountCents: 2500, currency: 'EUR', status: 'open', expiresAt: hourLater }] } }),
    await make('external', { status: 'awaiting_review', paymentStatus: 'pending', paymentReviewReason: 'external_order' }),
    await make('waiting', { status: 'awaiting_review', ...stripeProof('pi_e2e_waiting'), metadata: stripeMeta('pi_e2e_waiting') }),
    await make('printlabReported', { status: 'awaiting_payment', paymentStatus: 'pending', metadata: { lastPrintLabSubmission: { status: 'started', printLabJobId: 'pl_e2e_2' } } }),
    // (step 4.6, S6) an invoice order nobody has paid and nobody has authorized: production on credit asks for the reference of the invoice
    await make('invoiceUnpaid', { status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'invoice' }),
    // (step 4.6, S6) the money of a paid order was partly given back: the payment no longer covers it
    await make('refunded', { status: 'queued', ...stripeProof('pi_e2e_refunded'), refundedCents: 1000, metadata: stripeMeta('pi_e2e_refunded') }),
    // (step 4.6, S6) a refund asked for from the application whose outcome nobody knows yet: nothing is produced, and no authorization overrides it
    await make('refundPending', {
      status: 'queued', ...stripeProof('pi_e2e_refundpending'), metadata: stripeMeta('pi_e2e_refundpending'),
      refundOperations: {
        create: [{
          id: randomUUID(), paymentIntentId: 'pi_e2e_refundpending', amountCents: 1000, currency: 'EUR', expectedRefundedCents: 0, reason: 'duplicate', note: 'refund under way (e2e fixture)',
          status: 'unknown', attempts: 1, firstSentAt: now, adminId: admin.id,
        }],
      },
    }),
    // (step 4.6, S6) authorized once, but the money situation changed afterwards (the order is at revision 1, the authorization was given at 0): it is not valid any more
    await make('stale', {
      status: 'queued', paymentStatus: 'pending', financialRevision: 1,
      metadata: { productionAuthorization: { authorized: true, by: admin.id, at, reason: 'Agreed with the customer on the phone', kind: 'exceptional', financialRevision: 0 } },
    }),
    // ---- released ----
    await make('released', { status: 'queued', ...stripeProof('pi_e2e_released'), metadata: stripeMeta('pi_e2e_released') }),
    await make('authorized', {
      status: 'queued', paymentStatus: 'pending',
      metadata: { productionAuthorization: { authorized: true, by: admin.id, at, reason: 'Agreed with the customer on the phone', kind: 'exceptional', financialRevision: 0 } },
    }),
    await make('manual', {
      status: 'queued', paymentStatus: 'paid', paymentMethod: 'cash',
      metadata: { manualPayment: { by: admin.id, at, reason: 'Cash received at the counter', method: 'cash', receivedVia: 'cash', amountCents: 2500, currency: 'EUR' } },
    }),
    // (step 4.6, S6) produced on credit: an invoice, authorized as a commercial credit - NOT a payment, the amount is still due
    await make('credit', {
      status: 'queued', paymentStatus: 'pending', paymentMethod: 'invoice',
      metadata: {
        productionAuthorization: {
          authorized: true, by: admin.id, at, reason: 'Regular customer, pays at 30 days', kind: 'commercial_credit', financialRevision: 0,
          credit: { method: 'invoice', reference: 'INV-2026-0042', amountDueCents: 2500, currency: 'EUR', dueAt: '2026-11-30' },
        },
      },
    }),
    await make('sent', {
      status: 'printing', ...stripeProof('pi_e2e_sent'),
      metadata: { ...stripeMeta('pi_e2e_sent'), printLabSubmissions: [{ printLabJobId: 'pl_e2e_3', status: 'queued' }], stockworksConsumedAt: at },
    }),
    await make('uncertain', {
      status: 'queued', ...stripeProof('pi_e2e_uncertain'),
      metadata: {
        ...stripeMeta('pi_e2e_uncertain'),
        externalEffects: {
          'printlab:item:e2e-item-1': effect('printlab_submit', 'uncertain', { cause: 'timeout', message: 'The call to PrintLab timed out.' }),
          'stockworks:MW-E2E:1:-10:0': effect('stockworks_movement', 'confirmed', { externalId: '7', confirmedBy: 'response' }),
        },
      },
    }),
  ]
  const orders = Object.fromEntries(entries.map(([key, order]) => [key, order]))

  fs.writeFileSync(out, JSON.stringify({
    adminToken: sign(admin.id), staffToken: sign(staff.id), customerToken: sign(customer.id),
    adminId: admin.id, customerId: customer.id, printerId: printer.id, orders,
  }, null, 1))
  console.log(`fixture written to ${out} (${entries.length} orders, 1 customer, 1 administrator, 1 staff member)`)
  process.exit(0)
})().catch((err) => { console.error(err); process.exit(1) })
