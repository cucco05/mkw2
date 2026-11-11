// The two flags of the owner guard of the hosted checkout (R1-3 / KLOSS): CHECKOUT_OWNER_GUARD (P2) and CHECKOUT_REPEAT_GUARD (P3), each `off | shadow | on` - read here with the
// environment as a PARAMETER, for the checks of the configuration (lib/checkout-guards.ts, the administrator's environment check). The guard itself keeps its own reading of
// process.env (lib/checkout-owner-guard.ts, ownerGuardMode / requestedRepeatGuardMode, pinned by tests/owner-intent.test.ts); tests/checkout-flags.test.ts proves that the two
// readings agree for every value.
//
// A value is read trimmed and in any case. Empty or unset is `off`. Anything else that is not one of the three words is NOT RECOGNISED: it counts as `off` (the checkout as before - that is
// what the tests of P2/P3 pin outside production), and in production it is a configuration nobody can read - the checkout's fail-closed check (lib/checkout-guards.ts,
// checkoutConfigurationProblems) stops card checkout until it is fixed, and the administrator's environment check calls it out. Pure: the environment is a parameter.
type Env = Record<string, string | undefined>

export type GuardMode = 'off' | 'shadow' | 'on'
export const OWNER_GUARD_FLAG = 'CHECKOUT_OWNER_GUARD'
export const REPEAT_GUARD_FLAG = 'CHECKOUT_REPEAT_GUARD'
export const GUARD_FLAGS = [OWNER_GUARD_FLAG, REPEAT_GUARD_FLAG] as const

export function readGuardFlag(raw: string | undefined): { mode: GuardMode; recognised: boolean } {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'on' || value === 'shadow') return { mode: value, recognised: true }
  return { mode: 'off', recognised: value === '' || value === 'off' }
}

export const ownerGuardModeOf = (env: Env): GuardMode => readGuardFlag(env[OWNER_GUARD_FLAG]).mode
export const requestedRepeatGuardModeOf = (env: Env): GuardMode => readGuardFlag(env[REPEAT_GUARD_FLAG]).mode

/** the names of the guard flags whose value is set and is not off / shadow / on */
export function unrecognisedGuardFlags(env: Env): string[] {
  return GUARD_FLAGS.filter((name) => !readGuardFlag(env[name]).recognised)
}
