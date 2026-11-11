// R1-3 / KLOSS hardening C - the one reading of the owner guard's flags (lib/checkout-flags.ts), and what the checkout makes of it (lib/checkout-guards.ts): pure, no database.
//   * the reading is EXACTLY the one P2/P3 have (the guard keeps its own, lib/checkout-owner-guard.ts): the parser of P2/P3 is the oracle here, and the guard's reading agrees with it
//     for every value;
//   * a value that is not off / shadow / on is "off" for the guard and is reported as not recognised; empty or unset is a recognised off;
//   * the old card checkout: production switched off -> refused (as always); production with a flag nobody can read -> refused; owner guard on -> refused; shadow -> allowed, told;
//     off -> allowed;
//   * the configuration problems: an unreadable flag only in production; the old checkout beside the guard wherever it would run (outside production it always may).
import assert from 'node:assert/strict'
import test from 'node:test'
import { GUARD_FLAGS, ownerGuardModeOf, readGuardFlag, requestedRepeatGuardModeOf, unrecognisedGuardFlags } from '../lib/checkout-flags'
import { checkoutConfigurationProblems, getCheckoutBlocker, isLegacyCardCheckoutEnabled, legacyCardCheckoutVerdict } from '../lib/checkout-guards'
import { ownerGuardMode, requestedRepeatGuardMode } from '../lib/checkout-owner-guard'

// the parser P2 and P3 had, word for word (lib/checkout-owner-guard.ts before hardening C)
const oldParser = (raw: string | undefined) => {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'on' || value === 'shadow' ? value : 'off'
}
const VALUES: Array<string | undefined> = [
  undefined, '', ' ', '\t', 'on', 'ON', ' on ', 'On', 'shadow', 'SHADOW', ' Shadow\n', 'off', 'OFF', ' off ', 'onn', 'o n', 'true', 'false', '1', '0', 'yes', 'enabled', 'on;', 'on\u0000',
  ' on ', '﻿on', 'shadow on', 'null', 'undefined',
]

test('C flags: the reading of CHECKOUT_OWNER_GUARD and CHECKOUT_REPEAT_GUARD is exactly the one P2 and P3 had, for values of every kind', () => {
  for (const raw of VALUES) {
    assert.equal(readGuardFlag(raw).mode, oldParser(raw), JSON.stringify(raw))
    assert.equal(ownerGuardModeOf({ CHECKOUT_OWNER_GUARD: raw }), oldParser(raw), `owner ${JSON.stringify(raw)}`)
    assert.equal(requestedRepeatGuardModeOf({ CHECKOUT_REPEAT_GUARD: raw }), oldParser(raw), `repeat ${JSON.stringify(raw)}`)
  }
  // and only the flag that is read decides
  assert.equal(ownerGuardModeOf({ CHECKOUT_REPEAT_GUARD: 'on' }), 'off')
  assert.equal(requestedRepeatGuardModeOf({ CHECKOUT_OWNER_GUARD: 'on' }), 'off')
})

test('C flags: the reading with the environment as a parameter agrees with the guard\'s own reading of process.env (lib/checkout-owner-guard.ts), for every value of both flags', () => {
  const saved = { owner: process.env.CHECKOUT_OWNER_GUARD, repeat: process.env.CHECKOUT_REPEAT_GUARD }
  const put = (name: 'CHECKOUT_OWNER_GUARD' | 'CHECKOUT_REPEAT_GUARD', value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  try {
    for (const raw of VALUES) {
      put('CHECKOUT_OWNER_GUARD', raw)
      put('CHECKOUT_REPEAT_GUARD', raw)
      assert.equal(ownerGuardMode(), ownerGuardModeOf(process.env), `owner ${JSON.stringify(raw)}`)
      assert.equal(requestedRepeatGuardMode(), requestedRepeatGuardModeOf(process.env), `repeat ${JSON.stringify(raw)}`)
    }
  } finally {
    put('CHECKOUT_OWNER_GUARD', saved.owner)
    put('CHECKOUT_REPEAT_GUARD', saved.repeat)
  }
})

test('C flags: recognised are exactly the three words (any case, trimmed) and the empty value; everything else is reported - by name, for both flags', () => {
  for (const raw of VALUES) {
    const value = (raw ?? '').trim().toLowerCase()
    assert.equal(readGuardFlag(raw).recognised, ['', 'off', 'shadow', 'on'].includes(value), JSON.stringify(raw))
  }
  assert.deepEqual(GUARD_FLAGS, ['CHECKOUT_OWNER_GUARD', 'CHECKOUT_REPEAT_GUARD'])
  assert.deepEqual(unrecognisedGuardFlags({}), [])
  assert.deepEqual(unrecognisedGuardFlags({ CHECKOUT_OWNER_GUARD: 'on', CHECKOUT_REPEAT_GUARD: 'shadow' }), [])
  assert.deepEqual(unrecognisedGuardFlags({ CHECKOUT_OWNER_GUARD: 'onn' }), ['CHECKOUT_OWNER_GUARD'])
  assert.deepEqual(unrecognisedGuardFlags({ CHECKOUT_REPEAT_GUARD: 'true' }), ['CHECKOUT_REPEAT_GUARD'])
  assert.deepEqual(unrecognisedGuardFlags({ CHECKOUT_OWNER_GUARD: '1', CHECKOUT_REPEAT_GUARD: 'yes' }), ['CHECKOUT_OWNER_GUARD', 'CHECKOUT_REPEAT_GUARD'])
})

// the whole table of the old card checkout: environment x the old checkout's own switch x owner guard x repeat guard
test('C legacy: the verdict on the old card checkout, for every combination of production, its own switch and the two guard flags', () => {
  const owners: Array<string | undefined> = [undefined, 'off', 'shadow', 'on', 'onn']
  const repeats: Array<string | undefined> = [undefined, 'on', 'shadow', 'true']
  for (const production of [false, true]) {
    for (const legacy of [undefined, 'true', 'TRUE', 'false']) {
      for (const owner of owners) {
        for (const repeat of repeats) {
          const env = { NODE_ENV: production ? 'production' : 'test', LEGACY_CARD_CHECKOUT_ENABLED: legacy, CHECKOUT_OWNER_GUARD: owner, CHECKOUT_REPEAT_GUARD: repeat }
          const label = JSON.stringify(env)
          const switchedOn = !production || (legacy ?? '').trim().toLowerCase() === 'true'
          const unreadable = (owner === 'onn' || repeat === 'true')
          const mode = oldParser(owner)
          const expected = !switchedOn ? { allowed: false, reason: 'disabled' }
            : production && unreadable ? { allowed: false, reason: 'misconfigured' }
              : mode === 'on' ? { allowed: false, reason: 'owner_guard' }
                : { allowed: true, besideShadow: mode === 'shadow' }
          assert.deepEqual(legacyCardCheckoutVerdict(env), expected, label)
          assert.equal(isLegacyCardCheckoutEnabled(env), expected.allowed, label)
          // what the configuration check reports for the same environment
          const problems = checkoutConfigurationProblems(env)
          assert.deepEqual(problems.find((p) => p.kind === 'unrecognised_flag') ?? null, production && unreadable ? { kind: 'unrecognised_flag', flags: [...(owner === 'onn' ? ['CHECKOUT_OWNER_GUARD'] : []), ...(repeat === 'true' ? ['CHECKOUT_REPEAT_GUARD'] : [])] } : null, label)
          assert.deepEqual(problems.find((p) => p.kind === 'legacy_beside_owner_guard') ?? null, switchedOn && mode !== 'off' ? { kind: 'legacy_beside_owner_guard', mode } : null, label)
        }
      }
    }
  }
})

test('C legacy: the hosted checkout refuses to sell (CHECKOUT_MISCONFIGURED) only in production and only for a flag nobody can read; the old reasons keep their order', () => {
  const PROD = { NODE_ENV: 'production', HOSTED_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', TAX_MODE: 'none', BASE_URL: 'https://shop.example.test', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR' }
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: PROD }), null)
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, CHECKOUT_OWNER_GUARD: 'onn' } })?.code, 'CHECKOUT_MISCONFIGURED')
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, CHECKOUT_REPEAT_GUARD: 'yes' } })?.code, 'CHECKOUT_MISCONFIGURED')
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, CHECKOUT_OWNER_GUARD: 'shadow', CHECKOUT_REPEAT_GUARD: 'on' } }), null, 'recognised values are not a problem')
  // (the hosted checkout switched off, and payments not configured, are said first - as before)
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, HOSTED_CHECKOUT_ENABLED: undefined, CHECKOUT_OWNER_GUARD: 'onn' } })?.code, 'CHECKOUT_DISABLED')
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, STRIPE_SECRET_KEY: '', CHECKOUT_OWNER_GUARD: 'onn' } })?.code, 'PAYMENTS_NOT_CONFIGURED')
  // outside production an unreadable flag is "off", as it always was
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, NODE_ENV: 'development', CHECKOUT_OWNER_GUARD: 'onn' } }), null)
})
