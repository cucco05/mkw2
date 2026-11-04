// A clock a test can move FORWARD (DR-13). The reservation of a payment page, its expiry, the replay window, the retention of an idempotency key and the provider's own expiry are all
// judged against "now"; to ask what happens "two minutes later" or "after a day" the rows must NOT be edited (an edited `expiresAt` is another request: the stored request hash and the
// idempotency key would no longer describe it) - what moves is the clock. Every `Date.now()` and every `new Date()` of this process then answers real time + the offset, and so does the
// stand-in for Stripe (tests/security/_stripe-sim.ts), which never reads the database clock for anything a test can move.
// A child process gets the same offset in SIM_CLOCK_OFFSET_MS (the parent passes `clock.offset()`).
// Not moved: the database clock (`now()`, `clock_timestamp()`), which the payment synchronisation uses for its lease only.
const RealDate = Date
let offsetMs = Number(process.env.SIM_CLOCK_OFFSET_MS || 0)

class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offsetMs)
    else super(...(args as [number]))
  }
  static override now() { return RealDate.now() + offsetMs }
}

let installed = false
export function installShiftedDate() {
  if (installed) return
  installed = true
  ;(globalThis as { Date: DateConstructor }).Date = ShiftedDate as unknown as DateConstructor
}

// A row created AFTER the clock was moved must carry the moved time too: `createdAt @default(now())` is the real time of the database/engine, so to another process (whose clock is moved) a row
// made a moment ago would look hours old. The code under test is not changed to fix that: the test's Prisma client fills `createdAt` from the (moved) process clock when the writer did not.
// (The code written for DR-13 sets `createdAt` itself, from the same clock as `expiresAt`; this only makes the model coherent for the code that does not.)
type Middleware = (params: any, next: (params: any) => Promise<any>) => Promise<any>
const coherent = Symbol.for('mkw.coherentCreatedAt')
export function coherentCreatedAt(prisma: { $use: (middleware: Middleware) => void }) {
  if ((prisma as any)[coherent]) return
  ;(prisma as any)[coherent] = true
  prisma.$use(async (params, next) => {
    if (params.action === 'create' && (params.model === 'PaymentAttempt' || params.model === 'PrintOrder') && params.args?.data && params.args.data.createdAt === undefined) {
      params.args.data.createdAt = new Date()
    }
    return next(params)
  })
}

export const clock = {
  /** move the clock forward by `ms` (a test never moves it back inside a scenario) */
  shift(ms: number) { offsetMs += ms },
  /** back to real time (between scenarios, after the rows of the previous one were deleted) */
  reset() { offsetMs = 0 },
  offset() { return offsetMs },
  realNow() { return RealDate.now() },
}
installShiftedDate()
