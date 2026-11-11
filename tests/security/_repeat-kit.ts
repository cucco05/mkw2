// Helpers for the R1-3 / KLOSS P3 tests (the confirmation of a repeat purchase): the DR-13 kit plus what these scenarios need - a purchase paid the way a customer pays it, a request sent again with or
// without the confirmation, and the WRITERS OF THE MONEY OF ANOTHER ORDER exactly as production has them (audit point C): a refund and a dispute are made at the stand-in for Stripe and announced by
// the webhook, so that lib/payment-sync.ts - which locks the row of THAT order and takes no lock of the checkout - writes them. Not a test file (its name matches no test pattern).
// Import './_harness' FIRST in the test file.
import assert from 'node:assert/strict'
import type { Kit, Started, Who } from './_dr13-kit'
import { FINANCIAL_METADATA_PATHS, FINANCIAL_PREV_SELECT } from '../../lib/financial-revision'
import { GUEST_ACCESS_COOKIE } from '../../lib/guest-order-access'

export const REPEAT_CODE = 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED'
export const REPEAT_VALUE = /^rc1_[0-9a-f]{64}$/
export const bothOn = () => { process.env.CHECKOUT_OWNER_GUARD = 'on'; process.env.CHECKOUT_REPEAT_GUARD = 'on' }
export const repeatOff = () => { delete process.env.CHECKOUT_REPEAT_GUARD }
export const repeatOn = () => { process.env.CHECKOUT_REPEAT_GUARD = 'on' }
/** runs `work` with the repeat guard off (the purchases a scenario starts from are made the way P2 makes them), then puts it back as it was */
export async function withRepeatOff<T>(work: () => Promise<T>): Promise<T> {
  const was = process.env.CHECKOUT_REPEAT_GUARD
  repeatOff()
  try { return await work() } finally { if (was === undefined) repeatOff(); else process.env.CHECKOUT_REPEAT_GUARD = was }
}

/** a purchase of the kit's cart, paid by the customer and verified (made with the repeat guard off) */
export async function paidPurchase(k: Kit, who: Who, cart?: Record<string, unknown>): Promise<Started> {
  return withRepeatOff(async () => {
    const started = cart ? await startWithCart(k, who, cart) : await k.startCheckout(who)
    assert.equal(started.status, 200, `premise: the purchase was started (${started.status} ${JSON.stringify(started.json)})`)
    assert.equal((await k.customerPays(started.sessionId)).paid, true, 'premise: the page was paid')
    const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: started.orderId } })
    assert.equal(order.paymentStatus, 'paid', 'premise: the payment is verified')
    return started
  })
}

/** a checkout of another cart (startCheckout always uses the kit's) */
export async function startWithCart(k: Kit, who: Who, cart: Record<string, unknown>, key: string = k.newKey('cart')): Promise<Started> {
  const quote = await k.post('quote', cart, who)
  assert.equal(quote.status, 200, quote.text)
  const r = await k.post('session', { checkoutKey: key, expectedTotalCents: quote.json.totalCents, ...cart }, who)
  const attempt = r.json?.orderId ? await k.prisma.paymentAttempt.findFirst({ where: { orderId: r.json.orderId }, orderBy: { createdAt: 'desc' } }) : null
  const access = r.setCookies.find((cookie) => cookie.startsWith(`${GUEST_ACCESS_COOKIE}=`))?.split(';')[0] ?? null
  return { key, cart, total: quote.json.totalCents, orderId: r.json?.orderId, attemptId: attempt?.id as string, sessionId: attempt?.stripeSessionId as string, url: r.json?.url, accessCookie: access, who, status: r.status, json: r.json }
}

export type Body = Record<string, unknown> & { checkoutKey: string; expectedTotalCents: number }
export async function bodyFor(k: Kit, who: Who, o: { key?: string; cart?: Record<string, unknown> } = {}): Promise<Body> {
  const cart = o.cart ?? k.cart()
  const quote = await k.post('quote', cart, who)
  assert.equal(quote.status, 200, quote.text)
  return { checkoutKey: o.key ?? k.newKey('repeat'), expectedTotalCents: quote.json.totalCents as number, ...cart }
}
export const confirmed = (body: Body, value: unknown): Body => ({ ...body, confirmRepeat: true, repeatContext: value })
export const send = (k: Kit, who: Who, body: Body) => k.post('session', body, who)

type Answer = { status: number; json: any }
/** what a proposal says about itself: its keys, and that it is one */
export const keysOf = (answer: Answer) => Object.keys(answer.json ?? {}).sort().join(',')
export function assertProposal(answer: Answer, label = ''): string {
  assert.equal(answer.status, 409, `${label}: ${JSON.stringify(answer.json)}`)
  assert.equal(answer.json?.code, REPEAT_CODE, `${label}: ${JSON.stringify(answer.json)}`)
  assert.match(String(answer.json?.repeatContext), REPEAT_VALUE, label)
  return answer.json.repeatContext as string
}

/** a hook that runs once, then never again (a hook of the checkout runs at every transaction it passes) */
export function once<A extends unknown[]>(work: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let done = false
  return async (...args: A) => { if (done) return; done = true; await work(...args) }
}

// ---- the writers of another order's money, as production has them (audit point C) -------------------------------------------------------------------------------------------------------
async function intentOf(k: Kit, orderId: string) {
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
  assert.ok(order.stripePaymentIntentId, 'premise: the order is tied to its payment')
  const rows: any[] = await k.prisma.$queryRawUnsafe('SELECT body FROM fakestripe.intent WHERE id = $1', order.stripePaymentIntentId)
  assert.ok(rows[0], 'premise: the stand-in holds the payment')
  return { order, pi: order.stripePaymentIntentId as string, body: rows[0].body as Record<string, any> }
}
let eventSeq = 0
/** the payment of `orderId` is refunded AT THE PROVIDER (all of it, or `cents`), and the webhook announces it: lib/payment-sync.ts writes the refund (it locks that order's row - not the checkout's locks) */
export async function refundAtProvider(k: Kit, orderId: string, cents?: number) {
  const { order, pi, body } = await intentOf(k, orderId)
  const amount = cents ?? order.totalCents
  const next = { ...body, latest_charge: { ...body.latest_charge, amount_refunded: amount, refunded: amount >= Number(body.amount) } }
  await k.prisma.$executeRawUnsafe('UPDATE fakestripe.intent SET body = $2::jsonb WHERE id = $1', pi, JSON.stringify(next))
  const answer = await k.deliver({ id: `evt_SIM_refund_${process.pid}_${++eventSeq}`, object: 'event', type: 'charge.refunded', livemode: false, data: { object: { id: next.latest_charge.id, object: 'charge', payment_intent: pi } } })
  assert.equal(answer.status, 200, `the webhook of the refund was taken (${JSON.stringify(answer.json)})`)
  const after = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
  assert.equal(after.refundedCents, amount, 'the refund is recorded on the order')
  return after
}
/** the payment of `orderId` is disputed AT THE PROVIDER, and the webhook announces it (payment-sync puts the order under review: a payment in doubt) */
export async function disputeAtProvider(k: Kit, orderId: string) {
  const { pi, body } = await intentOf(k, orderId)
  const next = { ...body, latest_charge: { ...body.latest_charge, disputed: true } }
  await k.prisma.$executeRawUnsafe('UPDATE fakestripe.intent SET body = $2::jsonb WHERE id = $1', pi, JSON.stringify(next))
  const answer = await k.deliver({ id: `evt_SIM_dispute_${process.pid}_${++eventSeq}`, object: 'event', type: 'charge.dispute.created', livemode: false, data: { object: { id: `dp_SIM_${eventSeq}`, object: 'dispute', payment_intent: pi, charge: next.latest_charge.id } } })
  assert.equal(answer.status, 200, `the webhook of the dispute was taken (${JSON.stringify(answer.json)})`)
  return k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
}

// ---- what an order says about its money, frozen ---------------------------------------------------------------------------------------------------------------------------------------------
const readPath = (root: unknown, path: readonly string[]) => path.reduce<unknown>((value, key) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined), root)
/** the financial columns, the lines, the financial keys of the metadata and the revision of an order: what a confirmation must never change */
export async function moneyOf(k: Kit, orderId: string) {
  const select = { ...FINANCIAL_PREV_SELECT, financialRevision: true, items: { orderBy: { createdAt: 'asc' as const }, select: { id: true, quantity: true, unitPriceCents: true, totalCents: true } } }
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, select })
  const { metadata, ...columns } = order as Record<string, unknown>
  return JSON.stringify({ columns, financialMetadata: FINANCIAL_METADATA_PATHS.map(({ path }) => [path.join('.'), readPath(metadata, path) ?? null]) })
}
export async function checkoutBlockOf(k: Kit, orderId: string): Promise<Record<string, any>> {
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
  return ((order.metadata as any)?.checkout ?? {}) as Record<string, any>
}
