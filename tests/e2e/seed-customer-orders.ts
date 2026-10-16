// Seeds a THROW-AWAY test database for tests/e2e/customer-orders.responsive.spec.ts and tests/e2e/printer-machines.responsive.spec.ts: a customer with orders in
// every situation the customer area describes, another customer's order (which must never show), an administrator, and a session token for each.
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest E2E_FIXTURE=/tmp/fixture.json node --import tsx tests/e2e/seed-customer-orders.ts
// The server under test must run with the same JWT_SECRET as the test harness ('sectest-jwt-secret-0123456789abcdefghijklmnop'). Prints nothing secret to the
// terminal: the tokens go to the fixture file. Refuses to run on anything but a local `*_sectest` database (tests/security/_harness.ts).
import { db } from '../security/_harness'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const jwt = createRequire(`${process.cwd()}/package.json`)('jsonwebtoken')
const sign = (id: string) => jwt.sign({ sub: id }, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '1d' })
const LONG = 'Supporto-per-cuffie-con-nome-lunghissimo-senza-spazi-che-potrebbe-rompere-il-layout-su-uno-schermo-stretto-0123456789'

;(async () => {
  const out = process.env.E2E_FIXTURE
  if (!out) throw new Error('E2E_FIXTURE (path of the fixture file) is required')
  const prisma = await db()
  const upsertUser = async (email: string, name: string, role: string) =>
    (await prisma.user.findUnique({ where: { email } })) ?? prisma.user.create({ data: { email, passwordHash: 'x', name, role, isAdmin: role === 'admin' } as any })
  const customer = await upsertUser('e2e-customer@sectest.invalid', 'E2E Customer', 'customer')
  const other = await upsertUser('e2e-other@sectest.invalid', 'E2E Other', 'customer')
  const admin = await upsertUser('e2e-admin@sectest.invalid', 'E2E admin', 'admin')
  await prisma.printOrder.deleteMany({ where: { userId: { in: [customer.id, other.id] } } })

  const expired = { cancellation: { reason: 'checkout_expired', at: new Date().toISOString() } }
  const make = async (key: string, userId: string, data: Record<string, unknown>, title = LONG) => {
    const order = await prisma.printOrder.create({
      data: {
        userId, customerEmail: 'e2e@sectest.invalid', customerName: 'E2E', shippingMethod: 'pickup', currency: 'EUR', subtotalCents: 2500, totalCents: 2500,
        items: { create: [{ modelTitle: title, material: 'PLA', quantity: 2, unitPriceCents: 1250, totalCents: 2500 }] },
        ...data,
      } as any,
      select: { id: true, orderNumber: true },
    })
    return [key, order] as const
  }
  const entries = [
    await make('awaitingPayment', customer.id, { status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card' }),
    await make('confirming', customer.id, { status: 'awaiting_payment', paymentStatus: 'processing', paymentMethod: 'card' }),
    await make('abandoned', customer.id, { status: 'cancelled', paymentStatus: 'canceled', paymentMethod: 'card', metadata: expired }),
    await make('paidQueued', customer.id, { status: 'queued', paymentStatus: 'paid', paymentMethod: 'card', paidAt: new Date() }, 'Vaso'),
    await make('paidReview', customer.id, { status: 'awaiting_review', paymentStatus: 'paid', paymentMethod: 'card', paidAt: new Date(), paymentReviewReason: 'shipping_country' }, 'Lampada'),
    await make('quote', customer.id, { status: 'awaiting_review', paymentStatus: 'quote', paymentMethod: 'quote', totalCents: 0, subtotalCents: 0, metadata: { manualQuote: { priceStatus: 'to_be_quoted', reasons: [] } } }, 'Modello grande'),
    await make('lateMoney', customer.id, { status: 'cancelled', paymentStatus: 'paid', paymentMethod: 'card', paidAt: new Date(), paymentReviewReason: 'paid_after_cancel', metadata: expired }, 'Pagato tardi'),
    await make('someoneElse', other.id, { status: 'queued', paymentStatus: 'paid', paymentMethod: 'card', paidAt: new Date() }, 'ORDINE-DI-UN-ALTRO'),
  ]
  const orders = Object.fromEntries(entries.map(([key, order]) => [key, order]))
  fs.writeFileSync(out, JSON.stringify({ customerToken: sign(customer.id), adminToken: sign(admin.id), orders }, null, 1))
  console.log(`fixture written to ${out} (${entries.length} orders, 2 customers, 1 administrator)`)
  process.exit(0)
})().catch((err) => { console.error(err); process.exit(1) })
