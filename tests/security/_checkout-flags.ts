// The checkout flags of ONE test, whatever the security suite was started with.
//
// The suite is run three times (CHECKOUT_OWNER_GUARD / CHECKOUT_REPEAT_GUARD = off/off, on/off, on/on). A test whose answer depends on a flag says which value it is about, here, instead of
// reading the flag and choosing what to expect: a flag it pins is the same in the three runs; a flag it leaves out (undefined) is the suite's, and then its assertions must hold for EVERY
// value the suite is run with (that is what the three runs check).
// Whatever a request started in the background while the flags were pinned (the closing of pages at the provider after a hold, the verification of a page found paid) is waited for before
// the flags are put back: no job outlives the flags it was started under, nor the test.
import test from 'node:test'
import { pageJobsSettled } from '../../lib/checkout-pages'

export type CheckoutFlag = 'off' | 'shadow' | 'on'
export type CheckoutFlags = { owner?: CheckoutFlag; repeat?: CheckoutFlag }

const NAMES = { owner: 'CHECKOUT_OWNER_GUARD', repeat: 'CHECKOUT_REPEAT_GUARD' } as const

export async function withCheckoutFlags<T>(flags: CheckoutFlags, run: () => Promise<T>): Promise<T> {
  const saved = { owner: process.env[NAMES.owner], repeat: process.env[NAMES.repeat] }
  for (const which of ['owner', 'repeat'] as const) {
    const value = flags[which]
    if (value !== undefined) process.env[NAMES[which]] = value
  }
  try {
    return await run()
  } finally {
    await pageJobsSettled()
    for (const which of ['owner', 'repeat'] as const) {
      const value = saved[which]
      if (value === undefined) delete process.env[NAMES[which]]
      else process.env[NAMES[which]] = value
    }
  }
}

// The same, for EVERY test of a file: call it at the top of a file whose tests are all about one configuration (the old card checkout, for one, is the checkout of the owner guard OFF -
// beside the guard switched on it is refused: tests/security/legacy-beside-guard.sec.ts). Its hooks run before and after every other hook of the file.
export function checkoutFlagsForThisFile(flags: CheckoutFlags): void {
  const saved = { owner: process.env[NAMES.owner], repeat: process.env[NAMES.repeat] }
  test.before(() => {
    for (const which of ['owner', 'repeat'] as const) {
      const value = flags[which]
      if (value !== undefined) process.env[NAMES[which]] = value
    }
  })
  test.after(async () => {
    await pageJobsSettled()
    for (const which of ['owner', 'repeat'] as const) {
      const value = saved[which]
      if (value === undefined) delete process.env[NAMES[which]]
      else process.env[NAMES[which]] = value
    }
  })
}

// The answer to a repeat purchase that is asked a confirmation (R1-3 / KLOSS P3, docs/CHECKOUT-REPEAT-CONFIRMATION.md section 3): exactly these fields, the newest paid order named.
export const REPEAT_PROPOSAL_KEYS = ['code', 'error', 'orderId', 'orderNumber', 'repeatContext', 'repeatCount']
export const REPEAT_CONTEXT_FORMAT = /^rc1_[0-9a-f]{64}$/
