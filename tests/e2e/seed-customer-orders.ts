// Seeds a THROW-AWAY test database for tests/e2e/customer-orders.responsive.spec.ts, tests/e2e/printer-machines.responsive.spec.ts, tests/e2e/buyer-journey.spec.ts
// and tests/e2e/payment-return.responsive.spec.ts: a customer with orders in every situation the customer area describes, another customer's order (which must
// never show), an administrator, a public model of the shop that can be bought, and a session token for each.
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest E2E_FIXTURE=/tmp/fixture.json node --import tsx tests/e2e/seed-customer-orders.ts
// The server under test must run with the same JWT_SECRET as the test harness ('sectest-jwt-secret-0123456789abcdefghijklmnop'). Prints nothing secret to the
// terminal: the tokens go to the fixture file. Refuses to run on anything but a local `*_sectest` database (tests/security/_harness.ts).
import { db } from '../security/_harness'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const jwt = createRequire(`${process.cwd()}/package.json`)('jsonwebtoken')
const sign = (id: string) => jwt.sign({ sub: id }, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '1d' })
// An ASCII STL of a box (12 triangles): small, valid, and parsed by every STL reader.
function boxStl(x: number, y: number, z: number) {
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]]
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const body = faces.map(([a, b, c]) => `facet normal 0 0 0\n outer loop\n  vertex ${v[a].join(' ')}\n  vertex ${v[b].join(' ')}\n  vertex ${v[c].join(' ')}\n endloop\nendfacet`).join('\n')
  return `solid box\n${body}\nendsolid box\n`
}
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

  // The shop's settings a buyer needs: the minimum order is a CHOICE of the shop (unset blocks card payments in production), so the test shop chose none.
  await prisma.siteConfig.upsert({ where: { id: 'main' }, update: { minimumOrderSubtotalUsd: 0 } as any, create: { id: 'main', minimumOrderSubtotalUsd: 0 } as any })

  // A public model of the shop that can be bought (what the buyer journey and the payment return tests put in the cart). The size is well inside the A1 mini.
  // It is created ONCE and kept (same id on every run): the Discover page keeps its list for a while, so a model that changed id between two runs would not be found.
  const shopTitle = 'E2E modello del negozio'
  const shopFields = {
    // `<owner>/models/<file>` is the layout of the real storage (lib/file-access.ts: only the display folders of a published model's owner are readable by a guest). The file
    // itself is a 50 x 40 x 40 mm box, written into E2E_STORAGE_DIR (the folder the server under test is started with: STORAGE_DIR) so that the 3D previews of the cart and
    // of the model page have something to load, as they do for a real model; without E2E_STORAGE_DIR the model has no file and the previews say so.
    title: shopTitle, filePath: `${admin.id}/models/e2e-shop-model.stl`, viewerFilePath: `${admin.id}/models/e2e-shop-model.stl`, fileType: 'stl', userId: admin.id, visibility: 'public', material: 'PLA',
    volumeMm3: 60000, priceUsd: 12, effectivePriceUsd: 12, sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4,
  } as any
  const storageRoot = (process.env.E2E_STORAGE_DIR || '').trim()
  if (storageRoot) {
    const target = path.join(storageRoot, shopFields.filePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, boxStl(50, 40, 40))
  }
  const existing = await prisma.model.findFirst({ where: { title: shopTitle }, select: { id: true } })
  const shopModel = existing
    ? await prisma.model.update({ where: { id: existing.id }, data: shopFields, select: { id: true, title: true } })
    : await prisma.model.create({ data: shopFields, select: { id: true, title: true } })
  if (!(await prisma.modelPart.count({ where: { modelId: shopModel.id } }))) {
    await prisma.modelPart.create({ data: { modelId: shopModel.id, index: 0, name: 'Part 1', filePath: shopFields.filePath, volumeMm3: 60000, sizeXmm: 50, sizeYmm: 40, sizeZmm: 40 } as any })
  }
  const { updateModelPricingForModel } = await import('../../lib/model-pricing')
  await updateModelPricingForModel(shopModel.id)

  fs.writeFileSync(out, JSON.stringify({ customerToken: sign(customer.id), adminToken: sign(admin.id), orders, shopModel }, null, 1))
  console.log(`fixture written to ${out} (${entries.length} orders, 2 customers, 1 administrator)`)
  process.exit(0)
})().catch((err) => { console.error(err); process.exit(1) })
