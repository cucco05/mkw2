// Shared set-up of the S4 tests (production release): users, a shop model, the fake Stripe of the harness, two LOCAL fake HTTP servers standing in for PrintLab and
// StockWorks (./_fake-services.ts), builders for orders in every payment state, observation of what an operation changed, and calls to the REAL route handlers.
// Nothing here reaches a real printer, PrintLab, StockWorks or Stripe account.
//
// Import ./_harness FIRST in the test file (it sets the environment) - this module imports it too, so any order works as long as nothing else loads the app before.
import { db, installFakeStripe, resetDb, seedShopModel } from './_harness'
import { pointApplicationAt, startFakePrintLab, startFakeStockWorks, type FakePrintLab, type FakeStockWorks } from './_fake-services'
import assert from 'node:assert/strict'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { releaseHooks } from '../../lib/production-release'

export type Key = 'admin' | 'staff' | 'customer'
export const ORIGIN = 'http://localhost'
export const state = {
  viewers: {} as Record<Key, Viewer>,
  adminId: '',
  staffId: '',
  customerId: '',
  modelId: '',
  printLab: null as unknown as FakePrintLab,
  stockWorks: null as unknown as FakeStockWorks,
  restoreEnv: (() => undefined) as () => void,
}

export function as(viewer: Viewer | null) {
  viewerGuards.getViewer = async () => viewer
}
export const asKey = (key: Key) => as(state.viewers[key])

export async function setup() {
  await resetDb()
  const prisma = await db()
  const mk = (name: string, role: Key) => prisma.user.create({ data: { email: `${name}@sectest.invalid`, passwordHash: 'x', name, role, isAdmin: role === 'admin' } as any })
  const [admin, staff, customer] = await Promise.all([mk('relAdmin', 'admin'), mk('relStaff', 'staff'), mk('relCustomer', 'customer')])
  state.adminId = admin.id
  state.staffId = staff.id
  state.customerId = customer.id
  state.viewers = { admin: { id: admin.id, role: 'admin' }, staff: { id: staff.id, role: 'staff' }, customer: { id: customer.id, role: 'customer' } }
  state.modelId = (await seedShopModel()).model.id
  await installFakeStripe()
  state.printLab = await startFakePrintLab()
  state.stockWorks = await startFakeStockWorks()
  state.restoreEnv = pointApplicationAt({ printLab: state.printLab, stockWorks: state.stockWorks }, {
    PRINTLAB_WEBHOOK_SECRET: 'printlab-test-secret', PRINTLAB_SUBMIT_TIMEOUT_MS: '1500', STOCKWORKS_TIMEOUT_MS: '1500',
  })
  as(state.viewers.admin)
}
export async function teardown() {
  state.restoreEnv()
  await state.printLab?.close()
  await state.stockWorks?.close()
}
// the hooks and the services' behavior are put back after every test
export function resetSeams() {
  releaseHooks.afterLock = undefined
  releaseHooks.beforeExternalCall = undefined
  releaseHooks.afterExternalCall = undefined
  if (state.printLab) state.printLab.mode.submit = { kind: 'ok' }
  if (state.stockWorks) state.stockWorks.mode.movement = { kind: 'ok' }
  as(state.viewers.admin)
}

// ---- orders in every payment state ------------------------------------------------------------------------------------------------------------
export type Spec = {
  name?: string
  status?: string
  paymentStatus?: string
  reason?: string | null
  total?: number
  // the PROOF the server keeps of a payment: stripe = what lib/payment-sync.ts writes; manual = metadata.manualPayment
  evidence?: 'stripe' | 'manual' | null
  authorization?: boolean
  attempts?: string[]
  stripeRef?: boolean // a typed Stripe reference with no proof behind it
  metadata?: Record<string, unknown>
  items?: number
  // the order's metadata erased after the fact (an erased account)
  wipeMetadata?: boolean
  // (step 4.6, S6) refund operations the application requested on this order (rows of the table `RefundOperation`, written directly: the protocol that makes them is
  // not part of these fixtures). `applied` = the final state read back from Stripe was applied.
  refunds?: Array<{ status: string; applied?: boolean }>
}
let counter = 0
export async function makeOrder(spec: Spec, over: { status?: string; metadata?: Record<string, unknown> } = {}) {
  const prisma = await db()
  const n = ++counter
  const pi = `pi_rel${n}x${Date.now()}`
  const total = spec.total ?? 2500
  const metadata: Record<string, unknown> = {
    paymentIntentId: `ow_rel${n}x${Date.now()}`,
    ...(spec.evidence === 'stripe' ? { stripe: { paymentIntentId: pi, paymentStatus: 'paid' } } : {}),
    ...(spec.stripeRef ? { stripe: { paymentIntentId: pi } } : {}),
    // (step 4.6, S6) a payment attested by an administrator says how the money was received and how much; an authorization records the financial revision the order has
    ...(spec.evidence === 'manual' ? { manualPayment: { by: state.adminId, at: new Date().toISOString(), reason: 'cash received at the counter', method: 'cash', receivedVia: 'cash', amountCents: total, currency: 'EUR' } } : {}),
    ...(spec.authorization ? { productionAuthorization: { authorized: true, by: state.adminId, at: new Date().toISOString(), reason: 'agreed with the customer', kind: 'exceptional', financialRevision: 0 } } : {}),
    ...(spec.metadata ?? {}),
    ...(over.metadata ?? {}),
  }
  const itemCount = spec.items ?? 1
  const order = await prisma.printOrder.create({
    data: {
      status: over.status ?? spec.status ?? 'queued',
      paymentMethod: 'card',
      paymentStatus: spec.paymentStatus ?? 'pending',
      paymentReviewReason: spec.reason ?? null,
      subtotalCents: total,
      totalCents: total,
      currency: 'EUR',
      ...(spec.evidence === 'stripe' || spec.stripeRef ? { stripePaymentIntentId: pi } : {}),
      ...(spec.evidence === 'stripe' ? { paidAt: new Date() } : {}),
      metadata: metadata as any,
      items: { create: Array.from({ length: itemCount }, (_, index) => ({ modelId: state.modelId, modelTitle: `FAKE part ${index + 1}`, material: 'PLA', colors: ['#000000'], quantity: 1, unitPriceCents: Math.round(total / itemCount), totalCents: Math.round(total / itemCount) })) },
      ...(spec.attempts?.length ? { paymentAttempts: { create: spec.attempts.map((status) => ({ amountCents: total, currency: 'EUR', status, expiresAt: new Date(Date.now() + 3600_000) })) } } : {}),
    } as any,
  })
  if (spec.wipeMetadata) await prisma.printOrder.update({ where: { id: order.id }, data: { metadata: Prisma.JsonNull } })
  if (spec.refunds?.length) await addRefundOperations(order.id, pi, spec.refunds)
  return order
}
// A refund operation in a given state, the way the protocol leaves it: `firstSentAt` is written before the first call to Stripe (so an operation that never left has none),
// the id of the Refund once the API answered, `appliedAt` once the final state was read back and applied.
export async function addRefundOperations(orderId: string, paymentIntentId: string, refunds: ReadonlyArray<{ status: string; applied?: boolean; amountCents?: number }>) {
  const prisma = await db()
  const now = new Date()
  for (const refund of refunds) {
    const n = ++counter
    const neverSent = refund.status === 'requested' || refund.status === 'abandoned'
    const accepted = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(refund.status)
    await prisma.refundOperation.create({
      data: {
        id: randomUUID(), orderId, paymentIntentId, amountCents: refund.amountCents ?? 500, currency: 'EUR', expectedRefundedCents: 0, reason: 'duplicate',
        note: 'refund requested by the test fixture', status: refund.status, adminId: state.adminId,
        attempts: neverSent ? 0 : 1,
        firstSentAt: neverSent ? null : now,
        ...(accepted ? { stripeRefundId: `re_fixture${n}x${Date.now()}`, stripeRefundStatus: refund.status, acceptedAt: now } : {}),
        ...(refund.applied ? { appliedAt: now } : {}),
        ...(refund.status === 'unresolved' ? { unresolvedAt: now, unresolvedReason: 'window_expired_not_found' } : {}),
      },
    })
  }
}
// the common one: paid (verified, with proof), queued, ready to be sent
export const releasedSpec = (over: Spec = {}): Spec => ({ name: 'released', paymentStatus: 'paid', evidence: 'stripe', attempts: ['paid'], ...over })

export type ReleaseExpect = { released: boolean; authorizable?: boolean; code?: string; basis?: string }
// Every state the owner listed plus the ones found while reading the code, with what the release decision must say about each.
export const RELEASE_MATRIX: Array<Spec & { expect: ReleaseExpect }> = [
  // -- the states the owner listed
  { name: 'awaiting payment', status: 'awaiting_payment', expect: { released: false, authorizable: true, code: 'PAYMENT_NOT_VERIFIED' } },
  { name: 'payment being confirmed', status: 'awaiting_payment', paymentStatus: 'processing', attempts: ['processing'], expect: { released: false, authorizable: false, code: 'PAYMENT_PROCESSING' } },
  { name: 'payment under review (amount)', status: 'awaiting_payment', reason: 'amount', attempts: ['mismatch'], expect: { released: false, authorizable: false, code: 'PAYMENT_ON_HOLD' } },
  { name: 'payment under review (dispute on a paid order)', paymentStatus: 'paid', evidence: 'stripe', reason: 'dispute', expect: { released: false, authorizable: false, code: 'PAYMENT_ON_HOLD' } },
  { name: 'payment under review (delivery address missing)', status: 'awaiting_review', paymentStatus: 'paid', evidence: 'stripe', reason: 'shipping_address_missing', expect: { released: false, authorizable: false, code: 'PAYMENT_ON_HOLD' } },
  { name: 'payment confirmed', paymentStatus: 'paid', evidence: 'stripe', attempts: ['paid'], expect: { released: true, basis: 'stripe_verified' } },
  { name: 'outside order, not authorised', status: 'awaiting_review', reason: 'external_order', expect: { released: false, authorizable: true, code: 'EXTERNAL_ORDER_NOT_AUTHORIZED' } },
  { name: 'outside order, authorised by an administrator', status: 'awaiting_review', reason: 'external_order', authorization: true, expect: { released: true, basis: 'admin_authorization' } },
  { name: 'outside order, authorised, with a later money anomaly in the log', status: 'awaiting_review', reason: 'external_order', authorization: true, metadata: { paymentReview: [{ reason: 'duplicate_payment', at: new Date().toISOString() }] }, expect: { released: false, authorizable: false, code: 'PAYMENT_ON_HOLD' } },
  { name: 'cancelled after payment', status: 'cancelled', paymentStatus: 'paid', evidence: 'stripe', reason: 'paid_after_cancel', expect: { released: false, authorizable: false, code: 'PAYMENT_ON_HOLD' } },
  { name: 'odd Stripe attempts: a payment still being confirmed on a paid order', paymentStatus: 'paid', evidence: 'stripe', attempts: ['paid', 'processing'], expect: { released: false, authorizable: false, code: 'PAYMENT_PROCESSING' } },
  { name: 'odd Stripe attempts: a duplicate payment', paymentStatus: 'paid', evidence: 'stripe', reason: 'duplicate_payment', attempts: ['paid', 'mismatch'], expect: { released: false, authorizable: false, code: 'PAYMENT_ON_HOLD' } },
  { name: 'odd Stripe attempts: a mismatch left after the hold was accepted', paymentStatus: 'paid', evidence: 'stripe', attempts: ['paid', 'mismatch'], expect: { released: true, basis: 'stripe_verified' } },
  { name: 'free order made by an administrator', paymentStatus: 'free', total: 0, expect: { released: true, basis: 'free_order' } },
  { name: 'unpaid order with an explicit production authorisation', status: 'awaiting_payment', authorization: true, expect: { released: true, basis: 'admin_authorization' } },
  // -- found while reading the code
  { name: 'authorisation does not override a money hold', authorization: true, reason: 'amount', expect: { released: false, authorizable: false, code: 'PAYMENT_ON_HOLD' } },
  { name: 'authorisation does not override a payment being confirmed', authorization: true, paymentStatus: 'processing', attempts: ['processing'], expect: { released: false, authorizable: false, code: 'PAYMENT_PROCESSING' } },
  { name: 'authorisation does not override a Stripe payment page still open', authorization: true, attempts: ['open'], expect: { released: false, authorizable: false, code: 'PAYMENT_ACTIVE' } },
  { name: 'a Stripe payment page still open, no authorisation', status: 'awaiting_payment', attempts: ['open'], expect: { released: false, authorizable: false, code: 'PAYMENT_ACTIVE' } },
  { name: 'a payment page being created (reservation), no authorisation', status: 'awaiting_payment', attempts: ['creating'], expect: { released: false, authorizable: false, code: 'PAYMENT_ACTIVE' } },
  { name: 'paid with the proof, and a second page left open', paymentStatus: 'paid', evidence: 'stripe', attempts: ['paid', 'open'], expect: { released: true, basis: 'stripe_verified' } },
  { name: 'paid by a documented manual payment', paymentStatus: 'paid', evidence: 'manual', expect: { released: true, basis: 'manual_payment' } },
  { name: '"paid" with no proof at all (a legacy or administrative route)', paymentStatus: 'paid', expect: { released: false, authorizable: true, code: 'PAYMENT_UNPROVEN' } },
  { name: '"free" on an order that has a price', paymentStatus: 'free', total: 2500, expect: { released: false, authorizable: true, code: 'PAYMENT_UNPROVEN' } },
  { name: 'a typed Stripe reference with no verification', status: 'awaiting_payment', stripeRef: true, expect: { released: false, authorizable: true, code: 'PAYMENT_NOT_VERIFIED' } },
  { name: 'a quote request', status: 'awaiting_review', paymentStatus: 'quote', expect: { released: false, authorizable: true, code: 'PAYMENT_NOT_VERIFIED' } },
  // -- (step 4.6, S6, P2c) a refund requested from the application that is not over: nothing is produced, and nothing overrides it (the money is leaving)
  ...['requested', 'sending', 'unknown', 'pending', 'requires_action', 'unresolved'].map((status) => ({
    name: `refund in progress (${status})`, paymentStatus: 'paid', evidence: 'stripe' as const, attempts: ['paid'], refunds: [{ status }], expect: { released: false, authorizable: false, code: 'REFUND_IN_PROGRESS' },
  })),
  ...['succeeded', 'failed', 'canceled'].map((status) => ({
    name: `refund ${status}, its final state not read back and applied yet`, paymentStatus: 'paid', evidence: 'stripe' as const, attempts: ['paid'], refunds: [{ status, applied: false }], expect: { released: false, authorizable: false, code: 'REFUND_IN_PROGRESS' },
  })),
  { name: 'refund in progress, a valid authorisation does not override it', status: 'awaiting_payment', authorization: true, refunds: [{ status: 'unknown' }], expect: { released: false, authorizable: false, code: 'REFUND_IN_PROGRESS' } },
  { name: 'refund in progress, a manual payment does not override it', paymentStatus: 'paid', evidence: 'manual', refunds: [{ status: 'pending' }], expect: { released: false, authorizable: false, code: 'REFUND_IN_PROGRESS' } },
  { name: 'refund in progress, on a free order', paymentStatus: 'free', total: 0, refunds: [{ status: 'requested' }], expect: { released: false, authorizable: false, code: 'REFUND_IN_PROGRESS' } },
  // -- and what lifts it: an outcome that was read back and applied (a refund of a duplicate leaves the order's own refunded amount at 0), a refusal by the API (nothing left),
  //    an operation that is PROVED never to have been sent
  { name: 'refund over and applied (a duplicate payment was refunded)', paymentStatus: 'paid', evidence: 'stripe', attempts: ['paid'], refunds: [{ status: 'succeeded', applied: true }], expect: { released: true, basis: 'stripe_verified' } },
  { name: 'refund that failed, and the failure was applied', paymentStatus: 'paid', evidence: 'stripe', attempts: ['paid'], refunds: [{ status: 'failed', applied: true }], expect: { released: true, basis: 'stripe_verified' } },
  { name: 'refund abandoned: proved never to have been sent', paymentStatus: 'paid', evidence: 'stripe', attempts: ['paid'], refunds: [{ status: 'abandoned' }], expect: { released: true, basis: 'stripe_verified' } },
]

// ---- observation --------------------------------------------------------------------------------------------------------------------------------
export async function world() {
  const prisma = await db()
  await prisma.refundOperation.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.printer.deleteMany()
  // (the audit log is a hash chain: it is never cleaned, each test looks only at the events about its own order)
  state.printLab.requests.length = 0
  state.printLab.jobs.length = 0
  state.stockWorks.requests.length = 0
  state.stockWorks.movements.length = 0
  state.printLab.mode.submit = { kind: 'ok' }
  state.stockWorks.mode.movement = { kind: 'ok' }
}
export async function snap(orderId: string) {
  const prisma = await db()
  const [row, attempts, audits] = await Promise.all([
    prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } }),
    prisma.paymentAttempt.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    prisma.adminAuditEvent.count({ where: { targetId: orderId } }),
  ])
  return {
    row: JSON.parse(JSON.stringify(row)),
    attempts: JSON.parse(JSON.stringify(attempts)),
    audits,
    printLabSubmissions: state.printLab.submissions().length,
    printLabOther: state.printLab.otherCalls().length,
    stockPosts: state.stockWorks.posts().length,
  }
}
export type Snap = Awaited<ReturnType<typeof snap>>
// Everything the outside world heard and everything that records a PRODUCTION decision must be the same after a refusal.
export function assertNothingHappened(before: Snap, after: Snap, label: string) {
  assert.deepEqual(after.row, before.row, `${label}: the order row changed`)
  assert.deepEqual(after.attempts, before.attempts, `${label}: a payment attempt changed`)
  assert.equal(after.audits, before.audits, `${label}: an audit event was written`)
  assert.equal(after.printLabSubmissions, before.printLabSubmissions, `${label}: PrintLab was asked to do something`)
  assert.equal(after.printLabOther, before.printLabOther, `${label}: PrintLab received a command`)
  assert.equal(after.stockPosts, before.stockPosts, `${label}: stock was moved`)
}
// For the signals that are always recorded (PrintLab callback and link): the order's own state must not move, only the metadata may learn the signal.
export function assertOnlyMetadataMayChange(before: Snap, after: Snap, label: string) {
  for (const column of ['status', 'printerId', 'printerAssignedAt', 'printerAssignedBy', 'paymentStatus', 'paymentReviewReason', 'paidAt', 'totalCents', 'stripePaymentIntentId', 'failedAt', 'failureNote']) {
    assert.equal(after.row[column], before.row[column], `${label}: ${column} changed`)
  }
  assert.deepEqual(after.attempts, before.attempts, `${label}: a payment attempt changed`)
  assert.equal(after.printLabSubmissions, before.printLabSubmissions, `${label}: PrintLab was asked to do something`)
  assert.equal(after.stockPosts, before.stockPosts, `${label}: stock was moved`)
}
export async function auditActions(orderId: string) {
  const prisma = await db()
  return (await prisma.adminAuditEvent.findMany({ where: { targetId: orderId }, orderBy: { createdAt: 'asc' }, select: { action: true } })).map((event) => event.action)
}
export async function journalOf(orderId: string) {
  const prisma = await db()
  const { readJournal } = await import('../../lib/external-effects')
  return readJournal((await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })).metadata)
}

// ---- calling the real handlers ----------------------------------------------------------------------------------------------------------------
export function request(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}${url}`, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
export const bodyOf = async (res: Response) => res.clone().json().catch(() => ({})) as Promise<any>

export const callStatus = async (id: string, to: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/status/route')
  return (PATCH as any)(request(`/api/admin/orders/${id}/status`, 'PATCH', { status: to, ...extra }, headers), { params: Promise.resolve({ orderId: id }) }) as Promise<Response>
}
export const callAssign = async (id: string, printerId: string | null) => {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/assign-printer/route')
  return (PATCH as any)(request(`/api/admin/orders/${id}/assign-printer`, 'PATCH', { printerId }), { params: Promise.resolve({ orderId: id }) }) as Promise<Response>
}
export const callAutoQueue = async (headers: Record<string, string> = {}) => {
  const { POST } = await import('../../app/api/admin/printers/auto-queue/route')
  return (POST as any)(request('/api/admin/printers/auto-queue', 'POST', {}, headers)) as Promise<Response>
}
export const callSubmit = async (id: string, headers: Record<string, string> = {}) => {
  const { POST } = await import('../../app/api/admin/orders/[orderId]/printlab-submit/route')
  return (POST as any)(request(`/api/admin/orders/${id}/printlab-submit`, 'POST', {}, headers), { params: Promise.resolve({ orderId: id }) }) as Promise<Response>
}
export const callLink = async (id: string, status = 'completed') => {
  const { POST } = await import('../../app/api/admin/orders/[orderId]/printlab-link/route')
  return (POST as any)(request(`/api/admin/orders/${id}/printlab-link`, 'POST', { mode: 'manual', manual: { printLabJobId: `pl_manual_${id}`, status } }), { params: Promise.resolve({ orderId: id }) }) as Promise<Response>
}
export const callCallback = async (id: string, status: string) => {
  const { POST } = await import('../../app/api/printlab/jobs/[jobId]/route')
  return (POST as any)(new NextRequest(`${ORIGIN}/api/printlab/jobs/job1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer printlab-test-secret' },
    body: JSON.stringify({ status, source_order_id: id }),
  }), { params: Promise.resolve({ jobId: 'job1' }) }) as Promise<Response>
}
export const callEffects = async (method: 'GET' | 'POST', id: string, body?: unknown, headers: Record<string, string> = {}) => {
  const route = await import('../../app/api/admin/orders/[orderId]/external-effects/route')
  return ((route as any)[method])(request(`/api/admin/orders/${id}/external-effects`, method, body, headers), { params: Promise.resolve({ orderId: id }) }) as Promise<Response>
}
export const callDelete = async (id: string, reason: string | undefined = 'removing a duplicate order by mistake') => {
  const { DELETE } = await import('../../app/api/admin/orders/[orderId]/route')
  return (DELETE as any)(request(`/api/admin/orders/${id}`, 'DELETE', reason === undefined ? {} : { reason }), { params: Promise.resolve({ orderId: id }) }) as Promise<Response>
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// A local port that nothing listens on (it was free a moment ago): connecting to it is refused, so a request to it never leaves.
export async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
