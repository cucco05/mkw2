// R1-3 / KLOSS hardening B - the REGISTRY of the versions of the cart fingerprint (lib/cart-fingerprint.ts) and its rollout in two phases, without a database.
//   * today: version 2 current, version 1 lookup - the locks are named by version 2 ONLY (exactly the locks of before), and an order of either version is recognised;
//   * the roles give, for any registry, the set the locks are named by (current + transitional) and the set an order is recognised by (every version);
//   * the PHASES of a rollout of a new version, with a version of the test's own (never registered): two instances of adjacent phases share a lock AND each finds what the other writes; an
//     instance that does not know the new version shares a lock with one that writes it, and yet can not find what that one writes - the lock alone is not enough (the rule of the registry);
//   * the functions keep their names in lib/checkout-orders.ts; the repeat context carries the current version; the version written on an order is no financial fact; the test seam is null;
//   * a version leaves the registry only after the read-only check of scripts/cart-fingerprint-retirement.sql.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  assertRegistry, CART_FINGERPRINT_REGISTRY, cartFingerprint, cartFingerprintHooks, cartFingerprintV1, checkoutFingerprint, checkoutFingerprintV1, currentFingerprintVersion,
  fingerprintRegistry, fingerprintSetOf, type FingerprintVersion,
} from '../lib/cart-fingerprint'
import * as orders from '../lib/checkout-orders'
import { CART_FINGERPRINT_VERSION, pageLocksOf } from '../lib/checkout-owner-guard'
import { financialEvents, FINANCIAL_PREV_SELECT } from '../lib/financial-revision'

const input = { principalId: 'clregistryaccount000001', items: [{ modelId: 'clregistrymodel00000001', qty: 2, scale: 1, material: 'PLA', colors: ['#ffffff'] }] as never[], shippingMethod: 'pickup' as const, rush: false, expectedTotalCents: 2500 }
// a version of the TEST's own (never registered): another canonicalisation of the same purchase
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const v9: Omit<FingerprintVersion, 'role'> = { v: 9, cart: (i) => sha(`test-v9:${cartFingerprint(i)}`), checkout: (i) => sha(`test-v9:${checkoutFingerprint(i)}`) }
const v2 = CART_FINGERPRINT_REGISTRY[0]
const v1 = CART_FINGERPRINT_REGISTRY[1]
const as = (entry: Omit<FingerprintVersion, 'role'>, role: FingerprintVersion['role']): FingerprintVersion => ({ ...entry, role })
// the phases of the rollout of version 9 (docs/RILASCIO-PRODUZIONE.md, section 23)
const PHASES: Record<string, FingerprintVersion[]> = {
  before: [...CART_FINGERPRINT_REGISTRY],
  phase1: [as(v2, 'current'), as(v9, 'lookup'), as(v1, 'lookup')],
  phase2: [as(v9, 'current'), as(v2, 'transitional'), as(v1, 'lookup')],
  after: [as(v9, 'current'), as(v2, 'lookup'), as(v1, 'lookup')],
}
const versionsOf = (registry: FingerprintVersion[]) => {
  const set = fingerprintSetOf(input, registry)
  return { current: set.current.v, lock: set.lock.map((entry) => entry.v), lookup: set.lookup.map((entry) => entry.v), set }
}
// two instances of two registries can run side by side only if they meet at a lock AND each finds what the other writes
function sideBySide(a: FingerprintVersion[], b: FingerprintVersion[]) {
  const x = versionsOf(a)
  const y = versionsOf(b)
  return { shareALock: x.lock.some((v) => y.lock.includes(v)), aFindsB: x.lookup.includes(y.current), bFindsA: y.lookup.includes(x.current) }
}

test('registry TODAY: version 2 current, version 1 lookup - the locks named by version 2 only (the locks of before), an order of either version recognised', () => {
  assertRegistry(CART_FINGERPRINT_REGISTRY)
  assert.equal(Object.isFrozen(CART_FINGERPRINT_REGISTRY), true)
  assert.deepEqual(CART_FINGERPRINT_REGISTRY.map((entry) => [entry.v, entry.role]), [[2, 'current'], [1, 'lookup']])
  assert.equal(cartFingerprintHooks.registry, null, 'the test seam is null in production')
  assert.equal(fingerprintRegistry(), CART_FINGERPRINT_REGISTRY)
  const set = fingerprintSetOf(input)
  assert.deepEqual(set.current, { v: 2, checkout: checkoutFingerprint(input), cart: cartFingerprint(input) })
  assert.deepEqual(set.lock, [set.current], 'the locks: the current version only')
  assert.deepEqual(set.lookup, [set.current, { v: 1, checkout: checkoutFingerprintV1(input), cart: cartFingerprintV1(input) }], 'recognised: both')
  // the repeat context carries the current version; its constant is that version
  assert.equal(currentFingerprintVersion(), 2)
  assert.equal(CART_FINGERPRINT_VERSION, currentFingerprintVersion())
})

test('registry: lib/checkout-orders.ts exports the SAME functions under the names they always had', () => {
  assert.equal(orders.cartFingerprint, cartFingerprint)
  assert.equal(orders.checkoutFingerprint, checkoutFingerprint)
  assert.equal(orders.cartFingerprintV1, cartFingerprintV1)
  assert.equal(orders.checkoutFingerprintV1, checkoutFingerprintV1)
})

test('registry: only a registry the checkout can work with is accepted - exactly one current, distinct positive integer versions, known roles', () => {
  assert.throws(() => assertRegistry([as(v2, 'current'), as(v9, 'current')]), /Exactly one/)
  assert.throws(() => assertRegistry([as(v2, 'lookup'), as(v1, 'lookup')]), /Exactly one/)
  assert.throws(() => assertRegistry([as(v2, 'current'), as({ ...v1, v: 2 }, 'lookup')]), /distinct positive integers/)
  assert.throws(() => assertRegistry([as({ ...v2, v: 2.5 }, 'current')]), /distinct positive integers/)
  assert.throws(() => assertRegistry([{ ...v2, role: 'retired' as never }]), /a role/)
  assert.throws(() => fingerprintSetOf(input, [as(v2, 'lookup')]), /Exactly one/)
})

test('rollout: the roles of each phase - what is written, what the locks are named by, what is recognised', () => {
  const summary = Object.fromEntries(Object.entries(PHASES).map(([name, registry]) => { const { current, lock, lookup } = versionsOf(registry); return [name, { current, lock, lookup }] }))
  assert.deepEqual(summary, {
    before: { current: 2, lock: [2], lookup: [2, 1] },
    phase1: { current: 2, lock: [2], lookup: [2, 9, 1] },
    phase2: { current: 9, lock: [9, 2], lookup: [9, 2, 1] },
    after: { current: 9, lock: [9], lookup: [9, 2, 1] },
  })
  // a transitional version is never written: what an instance writes is its current version only
  for (const registry of Object.values(PHASES)) assert.equal(fingerprintSetOf(input, registry).current.v, registry.find((entry) => entry.role === 'current')?.v)
})

test('rollout in TWO phases: instances of adjacent phases meet at a lock AND find each other\'s orders; an instance that does not know the new version shares a lock with one that writes it, and yet can not find its orders', () => {
  for (const [a, b] of [['before', 'phase1'], ['phase1', 'phase2'], ['phase2', 'after']] as const) {
    assert.deepEqual(sideBySide(PHASES[a], PHASES[b]), { shareALock: true, aFindsB: true, bFindsA: true }, `${a} beside ${b}`)
  }
  // skipping phase 1: the old instance holds the same lock (version 2 is transitional, the new one locks it too) - and does not find what the new one writes
  assert.deepEqual(sideBySide(PHASES.before, PHASES.phase2), { shareALock: true, aFindsB: false, bFindsA: true }, 'the lock alone is not enough')
  // and two phases apart there is not even a lock in common
  assert.deepEqual(sideBySide(PHASES.before, PHASES.after), { shareALock: false, aFindsB: false, bFindsA: true })
})

test('registry: the version written on an order is NO financial fact (metadata.checkout.* is not a financial path) - writing it raises no financial revision', () => {
  const metadata = { source: 'stripe_checkout', checkout: { version: 1, fingerprint: 'f'.repeat(64), cartFingerprint: 'c'.repeat(64) }, stripe: { paymentStatus: 'pending' } }
  const prev = Object.fromEntries(Object.keys(FINANCIAL_PREV_SELECT).map((key) => [key, null]))
  assert.deepEqual(financialEvents({ ...prev, metadata }, { metadata: { ...metadata, checkout: { ...metadata.checkout, cartFingerprintVersion: 2 } } }), [])
})

test('registry: a version leaves it only after scripts/cart-fingerprint-retirement.sql, which only reads', () => {
  const sql = readFileSync(path.join(process.cwd(), 'scripts', 'cart-fingerprint-retirement.sql'), 'utf8')
  const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO)\b/i.test(code), false, 'the retirement check only reads')
  assert.match(code, /SET TRANSACTION READ ONLY|default_transaction_read_only/i)
  assert.match(code, /:'retire'/, 'the version to retire is a variable of psql')
})

test('registry: the page door (S3) names the owner locks by every version the locks are named by - and by the one cart of before when it is not told', async () => {
  const [c9, c2, c1] = ['9', '2', '1'].map((digit) => digit.repeat(64))
  const order = { id: 'clregistryorder00000001', userId: 'clregistryaccount000001', guestSessionHash: null, metadata: { checkout: { cartFingerprint: c2 } } }
  const claim = { kind: 'account' as const, userId: 'clregistryaccount000001' }
  // (an account's claim is read without the database)
  const names = (lockCarts?: string[]) => pageLocksOf(null as never, { order, claim, carts: [c2, c1], ...(lockCarts ? { lockCarts } : {}) })
  assert.deepEqual(await names(), [`checkout:owner:u:clregistryaccount000001:${c2}`], 'not told: the first cart, as before')
  assert.deepEqual(await names([c2]), [`checkout:owner:u:clregistryaccount000001:${c2}`], 'today: the current version only - the same name')
  assert.deepEqual(await names([c9, c2]), [`checkout:owner:u:clregistryaccount000001:${c2}`, `checkout:owner:u:clregistryaccount000001:${c9}`], 'phase 2: the new version and the transitional one')
})
