// S5 – an anonymous visitor must not be able to create orders that skip online payment.
// The checkout accepts paymentMethod in: card, paypal, cash, invoice, po, quote, comped.
// Only `comped` is restricted (admin only). These tests act as an UNAUTHENTICATED guest.
import { cartBody, db, installFakeStripe, postJson, resetDb, seedShopModel } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'

async function commitAsGuest(modelId: string, body: Record<string, unknown>) {
  const { POST } = await import('../../app/api/checkout/route')
  return postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, { commit: true, ...body }))
}

test.before(async () => {
  await resetDb()
  await installFakeStripe()
})

test('control: `comped` (free order) is refused for guests', async () => {
  const { model } = await seedShopModel()
  const res = await commitAsGuest(model.id, { paymentMethod: 'comped' })
  assert.equal(res.status, 403)
})

for (const method of ['cash', 'po', 'invoice'] as const) {
  test(`S5: a guest must not create a "${method}" order without paying`, { todo: 'S5 confirmed if this fails' }, async (t) => {
    await resetDb()
    const { model } = await seedShopModel()
    const extra = method === 'invoice'
      ? { paymentDetails: { billingEmail: 'buyer@sectest.invalid', billingContact: 'Fake Buyer' } }
      : method === 'po'
        ? { paymentDetails: { purchaseOrderNumber: 'PO-FAKE-1' } }
        : {}
    const res = await commitAsGuest(model.id, { paymentMethod: method, ...extra })
    const body = await res.clone().json().catch(() => ({}))
    const prisma = await db()
    const orders = await prisma.printOrder.findMany()
    t.diagnostic(
      `HTTP ${res.status}; orders created=${orders.length}`
      + (orders[0] ? ` status=${orders[0].status} paymentStatus=${orders[0].paymentStatus} total=${orders[0].totalCents}` : '')
      + (res.status >= 400 ? ` error="${body?.error}"` : ''),
    )
    assert.ok(res.status >= 400 && orders.length === 0, `guest obtained an unpaid "${method}" order`)
  })
}

test('S5-info: what does a guest "quote" request create? (observation, not a pass/fail verdict)', async (t) => {
  await resetDb()
  const { model } = await seedShopModel()
  const res = await commitAsGuest(model.id, { paymentMethod: 'quote' })
  const prisma = await db()
  const orders = await prisma.printOrder.findMany()
  t.diagnostic(
    `HTTP ${res.status}; orders=${orders.length}`
    + (orders[0] ? ` status=${orders[0].status} paymentStatus=${orders[0].paymentStatus}` : ''),
  )
  assert.ok(true)
})
