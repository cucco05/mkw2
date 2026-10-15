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

  const stripe = await installFakeStripe({
    'checkout.sessions.create': create,
    'checkout.sessions.retrieve': async (id: string) => {
      state.retrieveCalls++
      if (state.retrieveFails) throw stripeError('StripeConnectionError')
      const session = sessions.get(id)
      if (!session) throw stripeError('StripeInvalidRequestError', { code: 'resource_missing' })
      return session
    },
    'checkout.sessions.expire': async (id: string) => {
      state.expireCalls++
      const session = sessions.get(id)
      if (session) session.status = 'expired'
      return session
    },
  })
  return { stripe, sessions, state, byKey }
}
