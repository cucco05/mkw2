import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

import { adminRouteGuards } from '../app/api/admin/_utils'

function buildRequest(body: unknown, headers: Record<string, string> = { Origin: 'http://localhost' }) {
  return new NextRequest('http://localhost/api/admin/orders/order_123/printlab-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// The route reads and writes the order inside `withReleaseLock` (one transaction, the row locked, the facts read after the lock - tests/security/production-release.sec.ts
// runs it against the real database). Here the lock is replaced by one that hands the route a fake transaction and an order whose release is decided by the test.
function fakeLock(order: Record<string, unknown>, released: boolean, writes: { update?: any }) {
  return (async (_orderId: string, _action: string, fn: any) => fn({
    tx: { printOrder: { update: async (args: any) => { writes.update = args; return { id: order.id } } } },
    order: { paymentAttempts: [], ...order },
    decision: { released, state: released ? 'released' : 'payment_pending', basis: released ? 'stripe_verified' : null, reviewReason: null },
  })) as any
}

const routeContext = {
  params: Promise.resolve({ orderId: 'order_123' }),
} as any

test('admin PrintLab link route stores exact successful G-code data and triggers StockWorks', async () => {
  const route = await import('../app/api/admin/orders/[orderId]/printlab-link/route')
  const originalRequireAdmin = adminRouteGuards.requireAdmin
  const originalLock = route.printLabOrderLinkRouteOps.withReleaseLock
  const originalFetchSuccessful = route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes
  const originalConsume = route.printLabOrderLinkRouteOps.maybeConsumeStockForOrder
  const originalAudit = route.printLabOrderLinkRouteOps.recordAdminAuditEvent
  const writes: { update?: any } = {}
  let consumeArgs: any[] | null = null

  adminRouteGuards.requireAdmin = async () => 'admin_1'
  route.printLabOrderLinkRouteOps.withReleaseLock = fakeLock({ id: 'order_123', status: 'printing', metadata: { keep: 'value' } }, true, writes)
  route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes = async () => [
    {
      id: 'gcode_1',
      printer_name: 'X1C',
      file_name: 'fixture.gcode.3mf',
      plate_gcode: 'Metadata/plate_1.gcode',
      plate_index: 1,
      material_usage: [{ material: 'PLA', grams: 18.4, colors: ['Black'] }],
      completed_at: '2026-05-12T15:00:00.000Z',
    },
  ] as any
  route.printLabOrderLinkRouteOps.maybeConsumeStockForOrder = async (...args: any[]) => {
    consumeArgs = args
    return { ok: true, movements: 1 } as any
  }
  route.printLabOrderLinkRouteOps.recordAdminAuditEvent = async () => undefined

  try {
    const res = await route.POST(buildRequest({
      mode: 'successful_gcode',
      id: 'gcode_1',
      note: 'matched after print completed',
    }), routeContext)

    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.attachment.successfulGcodeId, 'gcode_1')
    assert.equal(payload.attachment.plateGcode, 'Metadata/plate_1.gcode')
    assert.deepEqual(writes.update.data.metadata.slicerStats.materials, [
      { material: 'PLA', grams: 18.4, colors: ['Black'], source: 'printlab' },
    ])
    assert.equal(writes.update.data.metadata.keep, 'value', 'what was already on the order is kept')
    assert.equal(writes.update.data.status, 'completed')
    assert.equal(payload.release.released, true)
    assert.deepEqual(consumeArgs, ['order_123', 'printlab-admin-link'])
    assert.deepEqual(payload.stockworks, { ok: true, movements: 1 })
  } finally {
    adminRouteGuards.requireAdmin = originalRequireAdmin
    route.printLabOrderLinkRouteOps.withReleaseLock = originalLock
    route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes = originalFetchSuccessful
    route.printLabOrderLinkRouteOps.maybeConsumeStockForOrder = originalConsume
    route.printLabOrderLinkRouteOps.recordAdminAuditEvent = originalAudit
  }
})

test('admin PrintLab link route does not trigger StockWorks without exact grams', async () => {
  const route = await import('../app/api/admin/orders/[orderId]/printlab-link/route')
  const originalRequireAdmin = adminRouteGuards.requireAdmin
  const originalLock = route.printLabOrderLinkRouteOps.withReleaseLock
  const originalFetchSuccessful = route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes
  const originalConsume = route.printLabOrderLinkRouteOps.maybeConsumeStockForOrder
  const originalAudit = route.printLabOrderLinkRouteOps.recordAdminAuditEvent
  const writes: { update?: any } = {}
  let consumeCallCount = 0

  adminRouteGuards.requireAdmin = async () => 'admin_1'
  route.printLabOrderLinkRouteOps.withReleaseLock = fakeLock({ id: 'order_123', status: 'queued', metadata: {} }, true, writes)
  route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes = async () => [
    { id: 'gcode_2', printer_name: 'P1S', completed_at: '2026-05-12T15:00:00.000Z' },
  ] as any
  route.printLabOrderLinkRouteOps.maybeConsumeStockForOrder = async () => {
    consumeCallCount += 1
    return { ok: true, movements: 1 } as any
  }
  route.printLabOrderLinkRouteOps.recordAdminAuditEvent = async () => undefined

  try {
    const res = await route.POST(buildRequest({ mode: 'successful_gcode', id: 'gcode_2' }), routeContext)

    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.stockworks.ok, false)
    assert.match(payload.stockworks.warning, /exact material grams/)
    assert.equal(consumeCallCount, 0)
  } finally {
    adminRouteGuards.requireAdmin = originalRequireAdmin
    route.printLabOrderLinkRouteOps.withReleaseLock = originalLock
    route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes = originalFetchSuccessful
    route.printLabOrderLinkRouteOps.maybeConsumeStockForOrder = originalConsume
    route.printLabOrderLinkRouteOps.recordAdminAuditEvent = originalAudit
  }
})

test('admin PrintLab link route rejects manual links without any PrintLab id', async () => {
  const route = await import('../app/api/admin/orders/[orderId]/printlab-link/route')
  const originalRequireAdmin = adminRouteGuards.requireAdmin
  adminRouteGuards.requireAdmin = async () => 'admin_1'

  try {
    const res = await route.POST(buildRequest({
      mode: 'manual',
      manual: { status: 'completed', printerName: 'X1C' },
    }), routeContext)

    assert.equal(res.status, 400)
    const payload = await res.json()
    assert.match(payload.error, /PrintLab job ID or successful G-code ID/)
  } finally {
    adminRouteGuards.requireAdmin = originalRequireAdmin
  }
})

test('admin PrintLab link route records the link but does not move an order that is not released', async () => {
  const route = await import('../app/api/admin/orders/[orderId]/printlab-link/route')
  const originalRequireAdmin = adminRouteGuards.requireAdmin
  const originalLock = route.printLabOrderLinkRouteOps.withReleaseLock
  const originalFetch = route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes
  const originalAudit = route.printLabOrderLinkRouteOps.recordAdminAuditEvent
  const writes: { update?: any } = {}
  adminRouteGuards.requireAdmin = async () => 'admin_1'
  route.printLabOrderLinkRouteOps.withReleaseLock = fakeLock({ id: 'order_123', status: 'awaiting_payment', metadata: {} }, false, writes)
  route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes = async () => [{ id: 'gcode_3', printer_name: 'A1 mini', completed_at: '2026-05-12T15:00:00.000Z' }] as any
  route.printLabOrderLinkRouteOps.recordAdminAuditEvent = async () => undefined
  try {
    const res = await route.POST(buildRequest({ mode: 'successful_gcode', id: 'gcode_3' }), routeContext)
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.release.released, false)
    assert.equal(payload.order.status, 'awaiting_payment', 'a PrintLab record does not start production')
    assert.equal('status' in writes.update.data, false, 'the status is not written')
    assert.ok(JSON.stringify(writes.update.data.metadata).includes('gcode_3'), 'the physical fact is recorded all the same')
  } finally {
    adminRouteGuards.requireAdmin = originalRequireAdmin
    route.printLabOrderLinkRouteOps.withReleaseLock = originalLock
    route.printLabOrderLinkRouteOps.fetchPrintLabSuccessfulGcodes = originalFetch
    route.printLabOrderLinkRouteOps.recordAdminAuditEvent = originalAudit
  }
})

test('admin PrintLab link route refuses a request from another site before anything else', async () => {
  const route = await import('../app/api/admin/orders/[orderId]/printlab-link/route')
  const originalRequireAdmin = adminRouteGuards.requireAdmin
  adminRouteGuards.requireAdmin = async () => 'admin_1'
  try {
    for (const headers of [{ Origin: 'https://evil.example' }, {}] as Array<Record<string, string>>) {
      const res = await route.POST(buildRequest({ mode: 'manual', manual: { printLabJobId: 'job_1' } }, headers), routeContext)
      assert.equal(res.status, 403)
      assert.equal((await res.json()).code, 'INVALID_ORIGIN')
    }
  } finally {
    adminRouteGuards.requireAdmin = originalRequireAdmin
  }
})
