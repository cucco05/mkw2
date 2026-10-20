// Step 4.6, S4 - safe release of orders to production. THE question every test here asks: may this order be assigned to a printer, sent to PrintLab, started or
// advanced, and may its material be taken out of stock? The answer must come from ONE rule (lib/order-payment-policy.ts, `releaseDecision`), be applied at the
// moment the effect happens (not only in a dashboard), and survive a payment that changes while the operation is running.
//
// Section A: the state matrix. Every state the owner listed (awaiting payment, payment being confirmed, payment under review, payment confirmed, outside order
//            not authorised / authorised, cancelled after payment, odd Stripe attempts, free order made by an administrator, unpaid order with an explicit
//            authorisation) plus the ones found while reading the code, against the REAL route handlers and library functions. For every REFUSED operation the
//            database row, the payment attempts and the audit log are byte-for-byte what they were, and the (fake) PrintLab and StockWorks never heard anything.
// Later sections (appended below): outside operations with an unknown outcome, concurrency, administrator routes (CSRF, roles), deletion of produced orders,
//            the Stripe attach proof, the views, and the static guards.
//
// Everything runs against a throw-away database, the fake Stripe of the harness, and two LOCAL fake HTTP servers standing in for PrintLab and StockWorks
// (tests/security/_fake-services.ts). No printer, PrintLab, StockWorks or Stripe account is ever contacted.
import './_harness'
import {
  as, asKey, assertNothingHappened, assertOnlyMetadataMayChange, bodyOf, callAssign, callAutoQueue, callCallback, callLink, callStatus, callSubmit, makeOrder,
  RELEASE_MATRIX as MATRIX, resetSeams, setup, snap, state, teardown, world,
} from './_release-fixtures'
import { db } from './_harness'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

test.before(setup)
test.after(teardown)
afterEach(resetSeams)

// ============================================================================================================================================
// A. The state matrix
// ============================================================================================================================================
for (const fx of MATRIX) {
  const { expect: want } = fx

  test(`A/status/${fx.name}: moving the order into production`, async () => {
    await world()
    const order = await makeOrder(fx)
    const before = await snap(order.id)
    const res = await callStatus(order.id, 'printing')
    const body = await bodyOf(res)
    if (want.released) {
      assert.equal(res.status, 200, `released order refused: ${JSON.stringify(body)}`)
      assert.equal((await snap(order.id)).row.status, 'printing')
      return
    }
    assert.equal(res.status, 409, `an order that is not released was moved: HTTP ${res.status}`)
    assert.equal(body.code, want.code, 'the refusal says why')
    assertNothingHappened(before, await snap(order.id), 'status')
  })

  test(`A/status+authorisation/${fx.name}: an explicit administrator authorisation`, async () => {
    if (want.released) return // nothing to authorise
    await world()
    const order = await makeOrder(fx)
    const before = await snap(order.id)
    const res = await callStatus(order.id, 'printing', { authorizeUnpaid: true, authorizationReason: 'goods handed over against cash at the counter' })
    if (want.authorizable) {
      assert.equal(res.status, 200, `an authorisable order was refused: ${JSON.stringify(await bodyOf(res))}`)
      const after = await snap(order.id)
      assert.equal(after.row.status, 'printing')
      assert.equal(after.row.metadata.productionAuthorization.authorized, true)
      assert.equal(after.row.metadata.productionAuthorization.by, state.adminId)
      assert.equal(after.audits, before.audits + 1, 'the decision leaves a trace')
    } else {
      assert.equal(res.status, 409, 'an authorisation overrode a payment that is held, being confirmed or still active')
      assert.equal((await bodyOf(res)).code, want.code)
      assertNothingHappened(before, await snap(order.id), 'status+authorisation')
    }
  })

  test(`A/assign/${fx.name}: assigning a printer`, async () => {
    await world()
    const prisma = await db()
    const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
    const order = await makeOrder(fx, { status: 'queued' })
    const before = await snap(order.id)
    const res = await callAssign(order.id, printer.id)
    if (want.released) {
      assert.equal(res.status, 200)
      assert.equal((await snap(order.id)).row.printerId, printer.id)
      return
    }
    assert.equal(res.status, 409)
    assert.equal((await bodyOf(res)).code, want.code)
    assertNothingHappened(before, await snap(order.id), 'assign')
  })

  test(`A/auto-queue/${fx.name}: the automatic queue`, async () => {
    await world()
    const prisma = await db()
    const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
    const order = await makeOrder(fx, { status: 'queued' })
    const before = await snap(order.id)
    const res = await callAutoQueue()
    assert.equal(res.status, 200)
    if (want.released) {
      assert.equal((await snap(order.id)).row.printerId, printer.id, 'a released order should be assigned')
      return
    }
    assertNothingHappened(before, await snap(order.id), 'auto-queue')
  })

  test(`A/printlab-submit/${fx.name}: sending to PrintLab`, async () => {
    await world()
    const order = await makeOrder(fx, { status: 'queued' })
    const before = await snap(order.id)
    const res = await callSubmit(order.id)
    if (want.released) {
      assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
      assert.equal(state.printLab.submissions().length, 1, 'one job per item')
      return
    }
    assert.equal(res.status, 409)
    assert.equal((await bodyOf(res)).code, want.code)
    assertNothingHappened(before, await snap(order.id), 'printlab-submit')
  })

  test(`A/printlab-link/${fx.name}: linking a PrintLab job that reports "completed"`, async () => {
    await world()
    const order = await makeOrder(fx, { status: 'queued' })
    const before = await snap(order.id)
    const res = await callLink(order.id, 'completed')
    assert.equal(res.status, 200, 'the link is recorded either way')
    const after = await snap(order.id)
    if (want.released) {
      assert.equal(after.row.status, 'completed')
      return
    }
    assertOnlyMetadataMayChange(before, after, 'printlab-link')
    assert.equal(after.row.status, before.row.status, 'a PrintLab signal advanced an order that is not released')
    assert.ok(JSON.stringify(after.row.metadata).includes(`pl_manual_${order.id}`), 'the physical fact is still recorded')
  })

  for (const printLabStatus of ['started', 'completed', 'failed', 'cancelled', 'submit_failed', 'something-new'] as const) {
    test(`A/callback(${printLabStatus})/${fx.name}: the PrintLab callback`, async () => {
      await world()
      const order = await makeOrder(fx, { status: 'queued' })
      const before = await snap(order.id)
      const res = await callCallback(order.id, printLabStatus)
      assert.equal(res.status, 200, 'PrintLab is always answered (it must not retry)')
      const after = await snap(order.id)
      if (!want.released) {
        assertOnlyMetadataMayChange(before, after, `callback ${printLabStatus}`)
        assert.equal(after.row.status, before.row.status, `a PrintLab "${printLabStatus}" advanced an order that is not released`)
        return
      }
      const expected = printLabStatus === 'started' ? 'printing' : printLabStatus === 'completed' ? 'completed' : ['failed', 'cancelled', 'submit_failed'].includes(printLabStatus) ? 'failed' : 'queued'
      assert.equal(after.row.status, expected)
    })
  }

  test(`A/orderworks-sync/${fx.name}: the OrderWorks fulfilment sync`, async () => {
    await world()
    const { syncOrderStatusFromFulfillment } = await import('../../lib/orderworks-sync')
    const order = await makeOrder(fx, { status: 'queued' })
    const piRef = (order.metadata as any).paymentIntentId as string
    const before = await snap(order.id)
    const moved = await syncOrderStatusFromFulfillment(piRef, 'ready')
    // the sync has always refused an order with a review reason, whatever it was (an authorised outside order included)
    const syncMayMove = want.released && !fx.reason
    if (syncMayMove) {
      assert.equal(moved?.status, 'post_process')
      return
    }
    assert.equal(moved, null)
    assertNothingHappened(before, await snap(order.id), 'orderworks-sync')
  })

  test(`A/stock/${fx.name}: taking the material out of stock`, async () => {
    await world()
    const { maybeConsumeStockForOrder } = await import('../../lib/stockworks-consumption')
    const order = await makeOrder(fx, { status: 'completed', metadata: { slicerStats: { materials: [{ material: 'PLA', grams: 20, colors: ['black'] }] } } })
    const before = await snap(order.id)
    const result = await maybeConsumeStockForOrder(order.id, 'matrix-test')
    if (want.released) {
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(state.stockWorks.posts().length, 1)
      return
    }
    assert.equal(result.ok, false)
    assert.equal((result as any).reason, 'not_released')
    assertNothingHappened(before, await snap(order.id), 'stock')
    // the refusal comes before StockWorks is asked anything - not even to read the inventory (the decision under the lock is the second line, not the first)
    assert.equal(state.stockWorks.requests.length, 0, 'StockWorks was contacted although the order is not released')
  })
}
