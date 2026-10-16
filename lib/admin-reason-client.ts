// The written reason that critical admin actions need (step 4.6, D8): asked in the browser, checked again by the server (lib/order-payment-evidence.ts).
// `window.prompt` is deliberate: it works the same on a desktop and on a phone, with the phone's keyboard, and needs no extra screen.
export const ADMIN_REASON_MIN = 10

export function askAdminReason(question: string, ask: (message: string) => string | null = (message) => (typeof window !== 'undefined' ? window.prompt(message) : null)): string | null {
  const answer = ask(`${question}\n\nWrite the reason (at least ${ADMIN_REASON_MIN} characters). It is kept in the audit log.`)
  const reason = (answer ?? '').trim()
  return reason.length >= ADMIN_REASON_MIN ? reason : null
}

export const REASON_REQUIRED_MESSAGE = `A written reason of at least ${ADMIN_REASON_MIN} characters is required: nothing was changed.`
