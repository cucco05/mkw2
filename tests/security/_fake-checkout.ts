// A stand-in for Stripe Checkout Sessions, good enough to test how the server behaves around it.
// It follows the two rules that matter: the same idempotency key always gives back the same session (also for calls that
// arrive at the same time), and it can fail in the ways Stripe can: unreachable, "created but the answer was lost", rejected.
import { db, installFakeStripe } from './_harness'

export type FakeSession = Record<string, any>

export function stripeError(type: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`fake ${type}`), { type, ...extra })
}

export async function installFakeCheckout() {
  const sessions = new Map<string, FakeSession>()
  const byKey = new Map<string, { params: string; promise: Promise<FakeSession> }>()
  const state = {
    createCalls: 0,
    createdSessions: 0,
    expireCalls: 0,
    retrieveCalls: 0,
    // failure injection (each counter is used up one call at a time)
    unreachableBeforeCreate: 0,
    lostAnswerAfterCreate: 0,
    rejectCreate: false,
    delayMs: 0,
    amountTotalOverride: null as number | null,
    currencyOverride: null as string | null,
    retrieveFails: false,
    // reads of PaymentIntents / sessions made by the payment sync (lib/payment-sync.ts)
    reads: [] as string[],
    failNextReads: 0,                                      // the next N reads fail like an unreachable Stripe
    afterSnapshot: null as null | ((kind: string, id: string) => Promise<void>),   // runs AFTER the state was captured and BEFORE the answer is returned
    // proof that no database transaction is open while "Stripe" is being called
    maxIdleInTransaction: 0,
    lastParams: null as any,
    allParams: [] as any[],
  }
  let seq = 0

  async function probeOpenTransactions() {
    const prisma = await db()
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`
    state.maxIdleInTransaction = Math.max(state.maxIdleInTransaction, rows[0]?.n ?? 0)
  }

  const build = (params: any): FakeSession => {
    const id = `cs_test_FAKE_${++seq}`
    const amount = (params.line_items || []).reduce((sum: number, line: any) => sum + line.price_data.unit_amount * line.quantity, 0)
    return {
      id,
      object: 'checkout.session',
      mode: params.mode,
      status: 'open',
      payment_status: 'unpaid',
      url: `https://checkout.stripe.test/c/pay/${id}`,
      amount_total: state.amountTotalOverride ?? amount,
      currency: state.currencyOverride ?? params.line_items?.[0]?.price_data?.currency,
      client_reference_id: params.client_reference_id,
      metadata: params.metadata,
      payment_method_types: params.payment_method_types,
      expires_at: params.expires_at,
      payment_intent: null,
    }
  }

  const create = async (params: any, options: any = {}) => {
    state.createCalls++
    state.lastParams = params
    state.allParams.push(params)
    await probeOpenTransactions()
    if (state.unreachableBeforeCreate > 0) {
      state.unreachableBeforeCreate--
      throw stripeError('StripeConnectionError')
    }
    if (state.rejectCreate) throw stripeError('StripeInvalidRequestError', { code: 'parameter_invalid_integer' })
    const key: string | undefined = options.idempotencyKey
    const serialized = JSON.stringify(params)
    let promise: Promise<FakeSession>
    const known = key ? byKey.get(key) : undefined
    if (known) {
      if (known.params !== serialized) throw stripeError('StripeIdempotencyError', { code: 'idempotency_error' })
      promise = known.promise // same key, also while the first call is still running: the same session
    } else {
      promise = (async () => {
        if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs))
        const session = build(params)
        sessions.set(session.id, session)
        state.createdSessions++
        return session
      })()
      if (key) byKey.set(key, { params: serialized, promise })
    }
    const session = await promise
    if (state.lostAnswerAfterCreate > 0 && !known) {
      state.lostAnswerAfterCreate--
      throw stripeError('StripeConnectionError') // Stripe created the session, but the server never saw the answer
    }
    return session
  }

  const intents = new Map<string, FakeSession>()
  let intentSeq = 0

  // A read returns the state AT THE MOMENT OF THE CALL (a copy); `afterSnapshot` may then delay the answer, which is how a test
  // makes one read slower than another and changes the state in between.
  const answer = async (kind: string, id: string, build: () => any) => {
    state.reads.push(`${kind}:${id}`)
    if (state.failNextReads > 0) {
      state.failNextReads--
      throw stripeError('StripeConnectionError')
    }
    const snapshot = JSON.parse(JSON.stringify(build()))
    if (state.afterSnapshot) await state.afterSnapshot(kind, id)
    return snapshot
  }

  const expandedSession = (session: FakeSession, params: any) => {
    const expand: string[] = params?.expand || []
    const copy = { ...session }
    if (session.payment_intent && expand.some((e) => e.startsWith('payment_intent'))) {
      const pi = intents.get(session.payment_intent as string)
      if (pi) copy.payment_intent = expand.includes('payment_intent.latest_charge') ? { ...pi } : { ...pi, latest_charge: pi.latest_charge?.id ?? null }
    }
    return copy
  }

  const stripe = await installFakeStripe({
    'checkout.sessions.create': create,
    'checkout.sessions.retrieve': async (id: string, params?: any) => {
      state.retrieveCalls++
      if (state.retrieveFails) throw stripeError('StripeConnectionError')
      const session = sessions.get(id)
      if (!session) throw stripeError('StripeInvalidRequestError', { code: 'resource_missing' })
      // reads made by the checkout code itself (no expand) are plain; the payment sync always asks for the payment intent
      if (!params?.expand) return session
      return answer('session', id, () => expandedSession(session, params))
    },
    'checkout.sessions.expire': async (id: string) => {
      state.expireCalls++
      const session = sessions.get(id)
      if (session) session.status = 'expired'
      return session
    },
    'paymentIntents.retrieve': async (id: string, params?: any) => {
      const pi = intents.get(id)
      if (!pi) throw stripeError('StripeInvalidRequestError', { code: 'resource_missing' })
      return answer('payment_intent', id, () => ({ ...pi, latest_charge: params?.expand?.includes('latest_charge') ? pi.latest_charge : pi.latest_charge?.id ?? null }))
    },
  })

  // ---- helpers to play the customer / Stripe --------------------------------------------------------------------------------
  const charge = (over: Record<string, unknown> = {}) => ({ id: `ch_FAKE_${intentSeq}`, receipt_url: 'https://pay.stripe.test/receipt', amount_refunded: 0, disputed: false, paid: true, status: 'succeeded', ...over })

  // The customer pays on Stripe's page. Defaults: the right amount, in the order's currency, a successful card payment.
  function pay(sessionId: string, over: {
    amount?: number; currency?: string; piStatus?: string; received?: number; paymentStatus?: string; piMetadata?: Record<string, string>;
    address?: Record<string, unknown> | null; email?: string | null; status?: string
  } = {}) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`unknown fake session ${sessionId}`)
    const amount = over.amount ?? session.amount_total
    const piId = `pi_test_FAKE_${++intentSeq}`
    const piStatus = over.piStatus ?? 'succeeded'
    const pi = {
      id: piId, object: 'payment_intent', status: piStatus, amount, amount_received: over.received ?? (piStatus === 'succeeded' ? amount : 0),
      currency: over.currency ?? session.currency, metadata: over.piMetadata ?? { ...session.metadata }, customer: null, latest_charge: charge(),
    }
    intents.set(piId, pi)
    session.status = over.status ?? 'complete'
    session.payment_status = over.paymentStatus ?? (piStatus === 'succeeded' ? 'paid' : 'unpaid')
    session.payment_intent = piId
    session.customer_details = { email: over.email === undefined ? 'buyer@example.test' : over.email, name: 'Mario Rossi' }
    const address = over.address === undefined
      ? { name: 'Mario Rossi', address: { line1: 'Via Roma 1', line2: null, city: 'Milano', state: 'MI', postal_code: '20100', country: 'IT' } }
      : over.address
    session.collected_information = address ? { shipping_details: address } : { shipping_details: null }
    return { pi, piId, session }
  }

  return { stripe, sessions, intents, state, byKey, pay }
}
