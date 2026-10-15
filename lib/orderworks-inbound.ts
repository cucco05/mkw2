// The inbound OrderWorks webhook (POST /api/makerworks/jobs) lets an outside service create and update job forms and, from them,
// orders. Its only protection is a shared secret, and the payment state it carries is whatever the sender declares.
// Step 4.0b: it is OFF in production unless it is switched on on purpose (the shop does not need it), and even when it is on
// the orders it creates never enter production by themselves (see createOrderFromJobForm). The secret itself
// (MAKERWORKS_INBOUND_SECRET) is shared with other routes (PrintLab callbacks, G-code upload) and stays.
type Env = Record<string, string | undefined>

export function isOrderWorksInboundEnabled(env: Env = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true
  return (env.ORDERWORKS_INBOUND_ENABLED || '').trim().toLowerCase() === 'true'
}
