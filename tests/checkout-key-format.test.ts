// R1-1a - the SHAPE of a checkout key (lib/checkout-key-format.ts). No browser, no database, no network.
//
// What these tests pin down, and what they deliberately do NOT claim:
//   * a strong key is "k" + exactly 32 base64url characters, at least 16 of them different: a FILTER against degenerate keys (a constant, a short cycle). A key that passes
//     is only well-formed. Nothing here proves where its bytes came from: the safety of a key rests on the SOURCE (crypto.getRandomValues, tests/checkout-client.test.ts),
//     never on its shape - one test below shows a predictable counter passing, on purpose, so nobody reads the filter as a proof;
//   * the module is pure and runs unchanged in a browser and on a server: no import, no Node API, no clock, no global state (checked on the code and by running it in a
//     context that has no Node globals at all).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { CHECKOUT_KEY_PATTERN } from '../lib/checkout-client'
import {
  CHECKOUT_KEY_BODY_LENGTH, CHECKOUT_KEY_RANDOM_BYTES, MIN_DISTINCT_BODY_CHARS, STRONG_CHECKOUT_KEY_PATTERN,
  checkoutKeyFromBytes, distinctBodyChars, isStrongCheckoutKey,
} from '../lib/checkout-key-format'

// ---- an oracle that does not use the module under test --------------------------------------------------------------------------
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const oracle = (value: unknown): boolean => typeof value === 'string' && /^k[A-Za-z0-9_-]{32}$/.test(value) && new Set(value.slice(1)).size >= 16
const base64url = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(Array.from(bytes))).toString('base64url')
// deterministic bytes (xorshift32, fixed seed): the same corpus on every run, so a failure is a failure and not a bad draw
function bytesFrom(seed: number) {
  let x = (seed * 2654435761) >>> 0 || 1
  return (length: number) => Uint8Array.from({ length }, () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x & 255 })
}
const FIXED_BYTES = Uint8Array.from([201, 18, 77, 140, 5, 230, 99, 171, 64, 33, 250, 122, 9, 188, 47, 215, 86, 142, 3, 159, 236, 70, 25, 104])
const FIXED_KEY = `k${base64url(FIXED_BYTES)}`
// a body with exactly `different` distinct characters (cycling the first `different` symbols of the alphabet), 32 long
const bodyWith = (different: number) => Array.from({ length: 32 }, (_, i) => ALPHABET[i % different]).join('')

test('the constants say what the shape is: "k" + 32 characters made of 24 random bytes, at least 16 different characters', () => {
  assert.equal(CHECKOUT_KEY_BODY_LENGTH, 32)
  assert.equal(CHECKOUT_KEY_RANDOM_BYTES, 24, '24 bytes = 192 bits')
  assert.equal(CHECKOUT_KEY_RANDOM_BYTES * 8, 192)
  assert.equal(Math.ceil((CHECKOUT_KEY_RANDOM_BYTES * 4) / 3), CHECKOUT_KEY_BODY_LENGTH, '24 bytes are exactly 32 base64url characters, no padding')
  assert.equal(MIN_DISTINCT_BODY_CHARS, 16)
  assert.equal(STRONG_CHECKOUT_KEY_PATTERN.source, '^k[A-Za-z0-9_-]{32}$')
})

test('a strong key is accepted; the shape is the whole story of what "strong" means here', () => {
  assert.equal(FIXED_KEY.length, 33)
  assert.equal(isStrongCheckoutKey(FIXED_KEY), true)
  const draw = bytesFrom(7)
  for (let i = 0; i < 200; i++) {
    const key = `k${base64url(draw(24))}`
    assert.equal(isStrongCheckoutKey(key), oracle(key), key)
  }
})

test('every other shape is refused: prefix, length, alphabet, padding, white space, line breaks, and anything that is not a string', () => {
  const body = FIXED_KEY.slice(1)
  const refused: unknown[] = [
    '', 'k', body, `K${body}`, `w${body}`, `x${body}`, `k${body.slice(1)}`, `k${body}A`, `k${body}${body}`, `kk${body}`,
    `k${body.slice(0, 31)}+`, `k${body.slice(0, 31)}/`, `k${body.slice(0, 31)}=`, `k${body.slice(0, 31)} `, `k${body.slice(0, 31)}.`, `k${body.slice(0, 31)}é`, `k${body.slice(0, 31)}\u0000`,
    ` ${FIXED_KEY}`, `${FIXED_KEY} `, `${FIXED_KEY}\n`, `\n${FIXED_KEY}`, `${FIXED_KEY}\r\n`, `${FIXED_KEY} `,
    'kKEYKEYKEYKEYKEYKEY', 'abcdefghijklmnopqrstuvwxyz', 'key-0000000000000001',
    null, undefined, 0, 33, true, false, {}, [], [FIXED_KEY], { toString: () => FIXED_KEY }, Symbol('k'), () => FIXED_KEY, new String(FIXED_KEY),
  ]
  for (const value of refused) assert.equal(isStrongCheckoutKey(value), false, String(typeof value === 'symbol' ? 'symbol' : JSON.stringify(value) ?? String(value)))
})

test('the different-characters rule is a filter against degenerate keys: 15 different characters are refused, 16 are accepted', () => {
  for (let different = 1; different <= 32; different++) {
    const key = `k${bodyWith(different)}`
    assert.equal(distinctBodyChars(key), different)
    assert.equal(isStrongCheckoutKey(key), different >= 16, `${different} different characters`)
    assert.equal(oracle(key), different >= 16)
  }
  assert.equal(isStrongCheckoutKey(`k${'a'.repeat(32)}`), false, 'a constant')
  assert.equal(isStrongCheckoutKey(`k${'ab'.repeat(16)}`), false, 'two characters in turn')
  assert.equal(isStrongCheckoutKey(`k${'0'.repeat(32)}`), false)
  assert.equal(isStrongCheckoutKey(`k${'_'.repeat(32)}`), false)
})

test('the keys of the old tests and of the old real-run fixture are refused: they are short or degenerate', () => {
  assert.equal(isStrongCheckoutKey('kKEYKEYKEYKEYKEYKEY'), false, 'k + 18 characters')
  assert.equal(isStrongCheckoutKey(`k${base64url(new Uint8Array(24).fill(7))}`), false, 'the 24 bytes of fill(7): four characters in turn')
  assert.equal(isStrongCheckoutKey(`k${base64url(new Uint8Array(24))}`), false, '24 zero bytes')
  assert.equal(isStrongCheckoutKey(`k${base64url(new Uint8Array(24).fill(255))}`), false, '24 bytes of 0xFF')
  assert.equal(isStrongCheckoutKey(`k${base64url(Uint8Array.from({ length: 24 }, (_, i) => (i % 2 ? 0xAA : 0x55)))}`), false, 'two bytes in turn')
  assert.equal(isStrongCheckoutKey(`k${base64url(Uint8Array.from({ length: 24 }, (_, i) => [1, 2, 3][i % 3]))}`), false, 'three bytes in turn')
})

test('LIMIT, written down on purpose: the shape cannot tell a predictable but varied sequence from random bytes - the safety of a key is the SOURCE, never this check', () => {
  const counter = `k${base64url(Uint8Array.from({ length: 24 }, (_, i) => i))}`
  assert.ok(distinctBodyChars(counter) >= MIN_DISTINCT_BODY_CHARS, `a counter has ${distinctBodyChars(counter)} different characters`)
  assert.equal(isStrongCheckoutKey(counter), true, 'it passes: the shape is not an entropy proof, and no caller may treat it as one')
  const stepped = `k${base64url(Uint8Array.from({ length: 24 }, (_, i) => (i * 37 + 11) & 255))}`
  assert.equal(isStrongCheckoutKey(stepped), true, 'the deterministic fixture of tests/real-run/guest-session.ts is well-formed too (that is its purpose)')
})

test('differential: the module and an independent oracle agree on 40 000 strings, random and adversarial', () => {
  const draw = bytesFrom(2026)
  const pick = (n: number) => draw(1)[0] % n
  const randomBody = (length: number, symbols: number) => Array.from({ length }, () => ALPHABET[pick(symbols)]).join('')
  let strong = 0
  for (let i = 0; i < 40_000; i++) {
    const kind = i % 8
    let value: string
    if (kind === 0) value = `k${randomBody(32, 64)}`
    else if (kind === 1) value = `k${randomBody(32, 20)}`                      // few symbols: many fail the filter
    else if (kind === 2) value = `k${randomBody(32, 10)}`
    else if (kind === 3) value = `k${randomBody(30 + (i % 5), 64)}`           // lengths 30..34
    else if (kind === 4) value = `${'kKwx'[pick(4)]}${randomBody(32, 64)}`   // other prefixes
    else if (kind === 5) value = `k${randomBody(31, 64)}${'+/= \né'[pick(6)]}`
    else if (kind === 6) value = `k${base64url(draw(24))}`
    else value = `k${bodyWith(1 + pick(32))}`
    assert.equal(isStrongCheckoutKey(value), oracle(value), JSON.stringify(value))
    if (oracle(value)) strong++
  }
  assert.ok(strong > 5_000, `the corpus has plenty of strong keys (${strong}) and plenty of refused ones`)
})

test('the exact chance that genuine random bytes fail the filter is about 1.5 in 10 million per draw: that is why a few redraws are enough and why the filter never blocks a real browser', () => {
  // 32 uniform draws from 64 symbols; dp[d] = chance of exactly d different symbols (exact occupancy, no sampling, so no flaky test)
  const symbols = 64
  let dp = new Array<number>(symbols + 1).fill(0)
  dp[0] = 1
  for (let t = 0; t < CHECKOUT_KEY_BODY_LENGTH; t++) {
    const next = new Array<number>(symbols + 1).fill(0)
    for (let d = 0; d <= symbols; d++) {
      if (!dp[d]) continue
      next[d] += dp[d] * (d / symbols)
      if (d < symbols) next[d + 1] += dp[d] * ((symbols - d) / symbols)
    }
    dp = next
  }
  const rejected = dp.slice(0, MIN_DISTINCT_BODY_CHARS).reduce((sum, p) => sum + p, 0)
  assert.ok(rejected > 1e-8 && rejected < 1e-6, `P(fewer than ${MIN_DISTINCT_BODY_CHARS} different) = ${rejected}`)
  assert.ok(rejected ** 4 < 1e-24, 'four redraws in a row failing is out of reach')
  const mean = dp.reduce((sum, p, d) => sum + p * d, 0)
  assert.ok(mean > 25 && mean < 26, `mean of different characters: ${mean}`)
})

// ---- from bytes to a key ---------------------------------------------------------------------------------------------------------
test('checkoutKeyFromBytes: "k" + the base64url of the 24 bytes, exactly what Node would write, with no padding', () => {
  assert.equal(checkoutKeyFromBytes(FIXED_BYTES), FIXED_KEY)
  const draw = bytesFrom(11)
  for (let i = 0; i < 2_000; i++) {
    const bytes = draw(24)
    const key = checkoutKeyFromBytes(bytes)
    assert.equal(key, `k${Buffer.from(bytes).toString('base64url')}`)
    assert.equal(key.length, 33)
    assert.equal(CHECKOUT_KEY_PATTERN.test(key), true, 'and the server already accepts every such key')
  }
  assert.equal(checkoutKeyFromBytes(Array.from(FIXED_BYTES)), FIXED_KEY, 'a plain array of numbers works as well as a typed array')
  assert.equal(checkoutKeyFromBytes(new Uint8Array(24)), `k${'A'.repeat(32)}`)
  assert.equal(checkoutKeyFromBytes(new Uint8Array(24).fill(255)), `k${'_'.repeat(32)}`)
})

test('checkoutKeyFromBytes gives "" - no key at all - for anything but exactly 24 bytes; it never throws and never invents a key', () => {
  const bad: unknown[] = [
    new Uint8Array(0), new Uint8Array(23), new Uint8Array(25), new Uint8Array(32), [], Array.from({ length: 24 }, () => 256), Array.from({ length: 24 }, () => -1),
    Array.from({ length: 24 }, () => 1.5), Array.from({ length: 24 }, () => Number.NaN), Array.from({ length: 24 }, () => '7'), Array.from({ length: 24 }, () => null),
    Array.from({ length: 23 }, () => 7), null, undefined, 24, 'x'.repeat(24), {}, { length: 24 }, { length: 24, 0: 1 }, true,
  ]
  for (const value of bad) assert.equal(checkoutKeyFromBytes(value as any), '', JSON.stringify(value) ?? String(value))
  const hostile = { get length(): number { throw new Error('boom') } }
  assert.doesNotThrow(() => checkoutKeyFromBytes(hostile as any))
  assert.equal(checkoutKeyFromBytes(hostile as any), '')
  const hostileElement = new Proxy(new Array(24).fill(7), { get(target, key) { if (key === '3') throw new Error('boom'); return Reflect.get(target, key) } })
  assert.doesNotThrow(() => checkoutKeyFromBytes(hostileElement as any))
  assert.equal(checkoutKeyFromBytes(hostileElement as any), '')
})

test('distinctBodyChars counts the 32 characters after the prefix, and nothing else', () => {
  assert.equal(distinctBodyChars(`k${'a'.repeat(32)}`), 1)
  assert.equal(distinctBodyChars(`x${'b'.repeat(32)}`), 1, 'the first character is the prefix, whatever it is')
  assert.equal(distinctBodyChars(`${'a'.repeat(5)}${'b'.repeat(2)}`), 2, 'everything after the first character counts, whatever the length')
  assert.equal(distinctBodyChars(FIXED_KEY), new Set(FIXED_KEY.slice(1)).size)
  assert.equal(distinctBodyChars(''), 0)
  assert.equal(distinctBodyChars('k'), 0)
  assert.equal(distinctBodyChars(undefined as any), 0, 'a non-string has no characters')
})

// ---- browser and server: the same file ------------------------------------------------------------------------------------------
const MODULE_PATH = path.join(process.cwd(), 'lib/checkout-key-format.ts')
const source = () => readFileSync(MODULE_PATH, 'utf8')
// verbatimModuleSyntax keeps an import even when nothing uses it (the compiler would otherwise drop it and hide it from the scan below)
const emitted = (module: ts.ModuleKind) => ts.transpileModule(source(), {
  compilerOptions: { module, target: ts.ScriptTarget.ES2020, removeComments: true, ...(module === ts.ModuleKind.ESNext ? { verbatimModuleSyntax: true } : {}) },
}).outputText

test('the module is pure and portable: no import, no Node API, no clock, no random source, no global state - checked on the code without its comments', () => {
  const code = emitted(ts.ModuleKind.ESNext)
  const forbidden: Array<[RegExp, string]> = [
    [/\bimport\b/, 'import'], [/\brequire\b/, 'require'], [/\bBuffer\b/, 'Buffer'], [/\bprocess\b/, 'process'], [/\bglobalThis\b/, 'globalThis'], [/\bwindow\b/, 'window'],
    [/\bdocument\b/, 'document'], [/\blocalStorage\b/, 'localStorage'], [/\bsessionStorage\b/, 'sessionStorage'], [/\bDate\b/, 'Date'], [/\bperformance\b/, 'performance'],
    [/\bsetTimeout\b|\bsetInterval\b/, 'timers'], [/\bfetch\b/, 'fetch'], [/\bMath\s*(\.|\[)\s*['"]?random/, 'Math.random'], [/\bcrypto\b/i, 'crypto'], [/\bnode:/, 'node:'],
    [/\bawait\b|\basync\b|\bPromise\b/, 'async'], [/\bconsole\b/, 'console'],
  ]
  for (const [pattern, name] of forbidden) assert.equal(pattern.test(code), false, `lib/checkout-key-format.ts must not use ${name}`)
  assert.equal(/^(let|var)\s/m.test(code), false, 'no mutable module state (a local variable inside a function is indented and is fine)')
  assert.equal(/^export const .*=\s*(\[|\{)/m.test(code), false, 'no exported mutable object or array')
})

test('the module runs in a context that has NO Node global at all (no Buffer, no process, no require): the browser case', () => {
  const sandbox: Record<string, unknown> = { exports: {}, module: { exports: {} } }
  const context = vm.createContext(sandbox)
  // wrapped in a function, as a bundler or Node would: top-level declarations of a bare script would become properties of the context
  vm.runInContext(`(function (exports, module) {\n${emitted(ts.ModuleKind.CommonJS)}\n})(exports, module)`, context)
  const api = sandbox.exports as Record<string, any>
  assert.equal(vm.runInContext('typeof Buffer + typeof process + typeof require + typeof crypto', context), 'undefinedundefinedundefinedundefined', 'the sandbox really has no Node global')
  assert.equal(api.isStrongCheckoutKey(FIXED_KEY), true)
  assert.equal(api.isStrongCheckoutKey(`k${'a'.repeat(32)}`), false)
  assert.equal(api.isStrongCheckoutKey(undefined), false)
  assert.equal(api.checkoutKeyFromBytes(Uint8Array.from(FIXED_BYTES)), FIXED_KEY, 'the same key as in Node: the encoder does not lean on btoa or Buffer')
  assert.equal(api.checkoutKeyFromBytes([1, 2, 3]), '')
  assert.equal(api.distinctBodyChars(FIXED_KEY), distinctBodyChars(FIXED_KEY))
  assert.deepEqual(Object.keys(sandbox).sort(), ['exports', 'module'], 'and it leaked nothing into the global scope')
})

test('the module does not change what it is given, gives the same answer every time, and every strong key already fits the pattern the server enforces today', () => {
  const bytes = Uint8Array.from(FIXED_BYTES)
  const first = checkoutKeyFromBytes(bytes)
  assert.deepEqual(Array.from(bytes), Array.from(FIXED_BYTES), 'the input bytes are not touched')
  for (let i = 0; i < 50; i++) assert.equal(checkoutKeyFromBytes(bytes), first)
  const draw = bytesFrom(99)
  for (let i = 0; i < 2_000; i++) {
    const key = checkoutKeyFromBytes(draw(24))
    if (isStrongCheckoutKey(key)) assert.equal(CHECKOUT_KEY_PATTERN.test(key), true, 'strong is a subset of what /api/checkout/session accepts: the server needs no change to take these keys')
  }
  assert.equal(STRONG_CHECKOUT_KEY_PATTERN.test(FIXED_KEY), true)
  assert.equal(STRONG_CHECKOUT_KEY_PATTERN.global, false, 'a pattern without the g flag keeps no lastIndex between calls')
  assert.equal(STRONG_CHECKOUT_KEY_PATTERN.sticky, false)
})

test('the module is part of the client bundle: it lives in lib/, and lib/checkout-client.ts is the only file of the client that decides what a key is', () => {
  const client = readFileSync(path.join(process.cwd(), 'lib/checkout-client.ts'), 'utf8')
  assert.match(client, /from '@\/lib\/checkout-key-format'/, 'the client uses the shared shape, not a copy of it')
  assert.equal(/'use client'|from 'react'/.test(source()), false, 'and the shared file has nothing of React in it')
})
