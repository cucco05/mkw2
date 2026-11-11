// R1-3 / KLOSS hardening B - the GOLDEN values of the cart fingerprints, versions 1 and 2 (tests/fixtures/cart-fingerprint-golden.json): fixed values, computed by the code of 79e3196, which stayed
// unchanged until hardening B moved it to lib/cart-fingerprint.ts. Two levels:
//   * server: the lines as the request sends them -> the schema of the checkout (checkoutItemSchema) -> the four fingerprints. A change of the canonical JSON, of the grouping of a complete copy, of
//     the defaults of the schema or of a version's function makes a value differ;
//   * client -> server: the cart as the browser keeps it (CartItem) -> toQuoteItem -> the request -> the schema -> the fingerprints. A change of the page's mapping makes a value differ.
// A value is NEVER edited: a new way of computing is a NEW version (lib/cart-fingerprint.ts). The values are recomputed INDEPENDENTLY by scripts/cart-fingerprint-golden.py (no code of the
// repository); the last test runs it where Python 3 is installed and says plainly when it is not.
// What today's version 2 is sensitive to is pinned too (a characterisation, not a wish): `null` and an absent field differ, the fields the server ignores (targetDimensions, priceMultiplier) count,
// the order of the colours counts; the order of the lines and the random key of a complete copy do not.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { checkoutItemSchema } from '../lib/checkout-quote'
import { toQuoteItem } from '../lib/checkout-client'
import { cartFingerprint, cartFingerprintV1, checkoutFingerprint, checkoutFingerprintV1 } from '../lib/checkout-orders'
import { CART_FINGERPRINT_REGISTRY } from '../lib/cart-fingerprint'

type Prints = { cart: string; checkout: string }
type GoldenCase = {
  name: string; principalId: string | null; shippingMethod: 'pickup' | 'ship'; rush: boolean; expectedTotalCents: number
  cart?: unknown[]; request: Array<Record<string, unknown>>; parsed: Array<Record<string, unknown>>; v1: Prints; v2: Prints
}
const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'cart-fingerprint-golden.json')
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: GoldenCase[] }
const roundTrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const byName = (name: string) => cases.find((entry) => entry.name === name) as GoldenCase
const input = (entry: GoldenCase) => ({ principalId: entry.principalId, items: roundTrip(entry.request.map((item) => checkoutItemSchema.parse(item))), shippingMethod: entry.shippingMethod, rush: entry.rush })

test('golden: the fixture holds the cases it is about - server and client, every version of the registry', () => {
  assert.equal(cases.length, 18)
  assert.equal(cases.filter((entry) => entry.cart).length, 4, 'four carts as the browser keeps them')
  // (a version without golden values can not be registered: lib/cart-fingerprint.ts)
  assert.deepEqual(CART_FINGERPRINT_REGISTRY.map((entry) => entry.v).sort(), [1, 2])
  for (const entry of cases) for (const v of ['v1', 'v2'] as const) for (const kind of ['cart', 'checkout'] as const) assert.match(entry[v][kind], /^[0-9a-f]{64}$/, `${entry.name} ${v}.${kind}`)
})

test('golden SERVER: the lines as the request sends them, through the schema of the checkout, give exactly the golden fingerprints of versions 1 and 2', () => {
  for (const entry of cases) {
    const parsed = roundTrip(entry.request.map((item) => checkoutItemSchema.parse(item)))
    assert.deepEqual(parsed, entry.parsed, `${entry.name}: what the schema makes of the request changed`)
    const base = input(entry)
    assert.deepEqual({
      v1: { cart: cartFingerprintV1(base), checkout: checkoutFingerprintV1({ ...base, expectedTotalCents: entry.expectedTotalCents }) },
      v2: { cart: cartFingerprint(base), checkout: checkoutFingerprint({ ...base, expectedTotalCents: entry.expectedTotalCents }) },
    }, { v1: entry.v1, v2: entry.v2 }, entry.name)
    // and the registry computes the same with each of its versions
    for (const version of CART_FINGERPRINT_REGISTRY) {
      const golden = version.v === 1 ? entry.v1 : entry.v2
      assert.deepEqual({ cart: version.cart(base), checkout: version.checkout({ ...base, expectedTotalCents: entry.expectedTotalCents }) }, golden, `${entry.name} v${version.v} (registry)`)
    }
  }
})

test('golden CLIENT -> SERVER: the cart as the browser keeps it, through toQuoteItem and the schema, gives the golden request and the golden fingerprints', () => {
  for (const entry of cases.filter((candidate) => candidate.cart)) {
    const request = roundTrip((entry.cart as never[]).map((item) => toQuoteItem(item)))
    assert.deepEqual(request, entry.request, `${entry.name}: what the page sends changed`)
    const base = input(entry)
    assert.equal(cartFingerprint(base), entry.v2.cart, entry.name)
    assert.equal(checkoutFingerprint({ ...base, expectedTotalCents: entry.expectedTotalCents }), entry.v2.checkout, entry.name)
  }
  // a price multiplier kept in an old cart is never sent
  assert.equal(byName('client: a price multiplier kept in an old cart is not sent').request.some((item) => 'priceMultiplier' in item), false)
})

test('golden: what version 2 is sensitive to TODAY (characterisation) - and version 1 is not like it', () => {
  const same = (a: string, b: string) => byName(a).v2.cart === byName(b).v2.cart
  // the same purchase for v2: the order of the lines, the key of a complete copy
  assert.equal(same('two lines A then B', 'two lines B then A (the same purchase for v2)'), true)
  assert.equal(same('a complete copy, set key X', 'the same copy, set key Y (the same purchase for v2)'), true)
  assert.notEqual(byName('two lines A then B').v1.cart, byName('two lines B then A (the same purchase for v2)').v1.cart, 'version 1 takes the lines as sent')
  assert.notEqual(byName('a complete copy, set key X').v1.cart, byName('the same copy, set key Y (the same purchase for v2)').v1.cart)
  // another purchase for v2: colours in another order, delivery and rush, who buys
  assert.equal(same('options: finish, infill, custom text (unicode), tolerance, two colours', 'the same with the colours in the other order (another purchase)'), false)
  assert.equal(same('one line, account, pickup', 'shipped, rush'), false)
  assert.equal(same('one line, account, pickup', 'a guest'), false)
  // sensitive to the SHAPE of the payload: null is not absence; fields the server ignores still count (pinned so that it can not get worse in silence)
  assert.equal(same('one line, account, pickup', 'infill and custom text null (an older page)'), false)
  assert.equal(same('one line, account, pickup', 'fields the server ignores: target dimensions, price multiplier'), false)
  // a set key null is no key: the same as no key at all
  assert.deepEqual(byName('a set key null (an older client: no key)').parsed.some((item) => 'setKey' in item), false)
  // the total is in the checkout fingerprint, not in the cart one
  assert.notEqual(byName('two lines A then B').v2.checkout, byName('two lines A then B').v2.cart)
})

test('golden: an INDEPENDENT recomputation (scripts/cart-fingerprint-golden.py, no code of the repository) gives every value', (t) => {
  const python = ['python3', 'python'].find((command) => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0)
  if (!python) { t.skip('Python 3 is not installed here: the independent recomputation is run where it is (it was, for the values of this fixture)'); return }
  const run = spawnSync(python, ['-I', 'scripts/cart-fingerprint-golden.py', FIXTURE], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  assert.match(run.stdout, /18 cases, 72 fingerprints recomputed independently: all equal/)
})
