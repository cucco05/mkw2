// Step 4.3 – the way back from the payment page and the customer area. The server side of the status was proved in step 4.1 (s2s3-step4.sec.ts); here:
//   * the page can not become a second way to read an order or to declare a payment (what the page and its pieces are allowed to touch);
//   * the customer area shows a customer ONLY their own orders, describes them by their payment, and never hides money or a doubt in the history.
// Throw-away database, fake data.
import { db, resetDb } from './_harness'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { listOrdersForUser, getOrderForUser } from '../../lib/orders'
import { describeCustomerOrder, splitOrdersForCustomer } from '../../lib/customer-order-labels'

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

// ---- what the return page may touch ---------------------------------------------------------------------------------------------------------
const PAGE_FILES = ['app/checkout/success/page.tsx', 'components/checkout/CheckoutStatus.tsx', 'components/checkout/useOrderStatus.ts', 'lib/order-status-client.ts']

test('the return page and its pieces have no database, no Stripe, no secret and read nothing from the address but the order id', () => {
  for (const file of PAGE_FILES) {
    const source = read(file)
    assert.doesNotMatch(source, /@\/lib\/db|prisma|from 'stripe'|require\('stripe'\)|STRIPE_|JWT_SECRET|process\.env\.(?!NEXT_PUBLIC_)/, `${file} touches the database, Stripe or a server secret`)
    assert.doesNotMatch(source, /session_id|payment_intent|redirect_status|payment_status|setup_intent|client_secret/i, `${file} reads a payment parameter from the address`)
    assert.doesNotMatch(source, /searchParams\.get\(\s*['"](?!order['"])/, `${file} reads an address parameter other than "order"`)
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `${file} injects HTML`)
  }
  const page = read('app/checkout/success/page.tsx')
  assert.deepEqual([...new Set([...page.matchAll(/query\.(\w+)/g)].map((m) => m[1]))], ['order'], 'the page reads only query.order')
})

test('the only server address the return page asks is the status endpoint, and it only reads', () => {
  const addresses = new Set<string>()
  for (const file of PAGE_FILES) for (const m of read(file).matchAll(/['"`](\/api\/[^'"`?$]*)/g)) addresses.add(m[1])
  assert.deepEqual([...addresses], ['/api/checkout/status'])
  const client = read('lib/order-status-client.ts')
  assert.match(client, /method: 'GET'/)
  assert.doesNotMatch(client, /method: '(POST|PUT|PATCH|DELETE)'|\bbody\s*:\s*(JSON|new |['"`{])/)
})

test('"paid" is only ever shown from the server\'s answer: the page never builds a state from the address, storage or the clock', () => {
  const component = read('components/checkout/CheckoutStatus.tsx')
  const hook = read('components/checkout/useOrderStatus.ts')
  assert.doesNotMatch(component + hook, /state:\s*['"]paid['"]|setState\(\{\s*phase:\s*'ready',\s*status:\s*\{/, 'no state is made up on the page')
  assert.doesNotMatch(component, /localStorage|document\.cookie|location\.(search|hash)/, 'the page does not read a payment claim from the browser')
})

test('the order id is kept away from other sites and from search engines', () => {
  const page = read('app/checkout/success/page.tsx')
  assert.match(page, /robots:\s*\{\s*index:\s*false/)
  assert.match(page, /referrer:\s*'no-referrer'/)
})

// ---- the customer area ---------------------------------------------------------------------------------------------------------------------
test('the customer area lists only the customer\'s own orders; nobody else\'s order can be opened; abandoned ones go to the history, money and doubts never do', async () => {
  await resetDb()
  const prisma = await db()
  const mk = (email: string) => prisma.user.create({ data: { email, passwordHash: 'x', name: email, role: 'customer' } })
  const [me, other] = [await mk('area-me@sectest.invalid'), await mk('area-other@sectest.invalid')]
  const expired = { cancellation: { reason: 'checkout_expired', at: new Date().toISOString() } }
  const make = async (userId: string, title: string, data: Record<string, unknown>) => (await prisma.printOrder.create({
    data: { userId, customerEmail: 'x@sectest.invalid', shippingMethod: 'pickup', currency: 'EUR', subtotalCents: 1000, totalCents: 1000, paymentMethod: 'card', items: { create: [{ modelTitle: title, material: 'PLA', quantity: 1, unitPriceCents: 1000, totalCents: 1000 }] }, ...data } as any,
  })).id
  const ids = {
    unpaid: await make(me.id, 'unpaid', { status: 'awaiting_payment', paymentStatus: 'pending' }),
    abandoned: await make(me.id, 'abandoned', { status: 'cancelled', paymentStatus: 'canceled', metadata: expired }),
    paid: await make(me.id, 'paid', { status: 'queued', paymentStatus: 'paid', paidAt: new Date() }),
    lateMoney: await make(me.id, 'late', { status: 'cancelled', paymentStatus: 'paid', paidAt: new Date(), paymentReviewReason: 'paid_after_cancel', metadata: expired }),
    quote: await make(me.id, 'quote', { status: 'awaiting_review', paymentStatus: 'quote', paymentMethod: 'quote', totalCents: 0, metadata: { manualQuote: { priceStatus: 'to_be_quoted' } } }),
    theirs: await make(other.id, 'ORDINE-DI-UN-ALTRO', { status: 'queued', paymentStatus: 'paid', paidAt: new Date() }),
  }
  const mine = await listOrdersForUser(me.id, 30)
  assert.equal(mine.some((order) => order.id === ids.theirs), false, 'another customer\'s order is never listed')
  assert.equal(mine.length, 5)
  const { current, history } = splitOrdersForCustomer(mine)
  assert.deepEqual(history.map((order) => order.id), [ids.abandoned])
  assert.deepEqual(new Set(current.map((order) => order.id)), new Set([ids.unpaid, ids.paid, ids.lateMoney, ids.quote]))
  const kind = (id: string) => describeCustomerOrder(mine.find((order) => order.id === id)!)
  assert.deepEqual([kind(ids.unpaid), kind(ids.paid), kind(ids.lateMoney), kind(ids.quote), kind(ids.abandoned)], ['awaiting_payment', 'production', 'under_review', 'quote_requested', 'closed_unpaid'])
  // the order page: mine yes, theirs no
  assert.ok(await getOrderForUser(ids.unpaid, me.id))
  assert.equal(await getOrderForUser(ids.theirs, me.id), null)
  assert.equal(await getOrderForUser(ids.unpaid, other.id), null)
  // and the labels did not touch the data
  const again = await prisma.printOrder.findUniqueOrThrow({ where: { id: ids.unpaid } })
  assert.deepEqual([again.status, again.paymentStatus], ['awaiting_payment', 'pending'])
})
