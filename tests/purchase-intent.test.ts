// R1-1b - the PURE rules of the guard that keeps one purchase key from making a second order (lib/purchase-intent.ts). No database, no network, no clock.
//
// What is pinned here, one block per rule (the same rules are proved against a real database and a real route in tests/security/purchase-key.sec.ts):
//   P1  the fingerprint of a key: SHA-256("mw:purchase-key:v1:" + key), 64 lower-case hex, only for a STRONG key, never the key itself, in a name space of its own;
//   P2  who owns an order: the account's order is never a guest's, the session counts only when it is the same NON-NULL hash, the access cookie only for that very order;
//   P3  the INTERNAL classification of a purchase (never an answer to a request): three verdicts and no other (paid / in_doubt / started), default-deny, nothing "closed";
//   P4  the support code: ten hex digits taken from the fingerprint, in the shape XXXXX-XXXXX, never the whole fingerprint;
//   P5  the refusal: ONE for every order and every state of it (S-01 of the independent audit) - 409, one code, one sentence, no identifier and nothing about money;
//   P6  the module is pure: it imports only the hash function and the key-shape filter, and it reads no clock, no environment, no random source.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  PURCHASE_KEY_DOMAIN, PURCHASE_REFUSAL_CODE, SUPPORT_CODE_PATTERN, classifyForeignPurchase, isPurchaseKeyHash, ownershipProof, purchaseKeyFor, purchaseKeyLockName, purchaseRefusal, supportCodeFor,
  type PurchaseVerdict,
} from '../lib/purchase-intent'
import { checkoutKeyFromBytes, isStrongCheckoutKey } from '../lib/checkout-key-format'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
// 24 bytes that differ from seed to seed and are the same on every run (the first 24 bytes of the SHA-256 of the seed)
const bytes = (seed: number) => Uint8Array.from(createHash('sha256').update(`purchase-intent-test-seed:${seed}`).digest().subarray(0, 24))
const strong = (seed: number) => {
  const key = checkoutKeyFromBytes(bytes(seed))
  assert.ok(isStrongCheckoutKey(key), `seed ${seed} gives a strong key`)
  return key
}
const root = path.resolve(__dirname, '..')

// ---- P1 -----------------------------------------------------------------------------------------------------------------------------
test('P1: the fingerprint of a strong key is SHA-256 of the domain text plus the key - 64 lower-case hex - and is deterministic', () => {
  assert.equal(PURCHASE_KEY_DOMAIN, 'mw:purchase-key:v1:')
  for (let seed = 0; seed < 40; seed++) {
    const key = strong(seed)
    const hash = purchaseKeyFor(key)
    assert.equal(hash, sha256(`mw:purchase-key:v1:${key}`))
    assert.match(hash as string, /^[0-9a-f]{64}$/)
    assert.equal(purchaseKeyFor(key), hash, 'the same key, the same fingerprint')
  }
})

test('P1: different keys give different fingerprints, and the fingerprint contains nothing of the key', () => {
  const seen = new Set<string>()
  for (let seed = 0; seed < 300; seed++) {
    const key = strong(seed)
    const hash = purchaseKeyFor(key) as string
    assert.ok(!seen.has(hash), `seed ${seed}: a fingerprint of its own`)
    seen.add(hash)
    assert.ok(!hash.includes(key.slice(1, 9)), 'the key is not visible in its fingerprint')
  }
})

test('P1: the name space is its own - the fingerprint is none of the other hashes made from the same key', () => {
  const key = strong(7)
  const hash = purchaseKeyFor(key) as string
  const sessionHash = sha256('a-session-hash')
  const others = [
    sha256(key),
    sha256(`mw:checkout-key:v1:some-account:${key}`),
    sha256(`mw:checkout-key:v2:guest-session:${sessionHash}:${key}`),
    sha256(`mw:purchase-key:v2:${key}`),
    sha256(`mw:purchase-key:${key}`),
  ]
  for (const other of others) assert.notEqual(hash, other)
})

test('P1: only a STRONG key has a fingerprint - weak, degenerate, mistyped and non-string values have none, and nothing throws', () => {
  const body = strong(3).slice(1)
  const twoLetters = `k${'ab'.repeat(16)}`
  const fifteen = `k${Array.from({ length: 32 }, (_, i) => 'ABCDEFGHIJKLMNO'[i % 15]).join('')}`
  const sixteen = `k${Array.from({ length: 32 }, (_, i) => 'ABCDEFGHIJKLMNOP'[i % 16]).join('')}`
  assert.equal(new Set(fifteen.slice(1)).size, 15)
  assert.equal(new Set(sixteen.slice(1)).size, 16)
  const refused: unknown[] = [
    '', 'x', 'gs-key-000001-abcdefghij', 'kKEYKEYKEYKEYKEYKEY', `k${'a'.repeat(32)}`, twoLetters, fifteen,
    `k${body.slice(1)}`, `k${body}0`, `K${body}`, `x${body}`, ` k${body}`, `k${body} `, `k${body.slice(0, 10)}!${body.slice(11)}`, `k${body.slice(0, 10)}=${body.slice(11)}`,
    `k${'0123456789abcdefghijklmnopqrstuv'}\n`, 'k' + 'è'.repeat(32),
    undefined, null, 42, true, {}, [], [strong(1)], Symbol('k'), () => strong(1), 12345678901234567890n,
  ]
  for (const value of refused) {
    let result: unknown = 'not called'
    assert.doesNotThrow(() => { result = purchaseKeyFor(value) }, String(typeof value))
    assert.equal(result, null, `no fingerprint for ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`)
  }
  // ...and the boundary is exactly the one of the key-shape filter: sixteen different characters are enough
  assert.equal(purchaseKeyFor(sixteen), sha256(`mw:purchase-key:v1:${sixteen}`))
})

test('P1: isPurchaseKeyHash accepts exactly 64 lower-case hex digits', () => {
  assert.equal(isPurchaseKeyHash(sha256('x')), true)
  for (const value of [sha256('x').toUpperCase(), sha256('x').slice(1), `${sha256('x')}0`, `k${sha256('x').slice(1)}`, '', 42, null, undefined, {}]) assert.equal(isPurchaseKeyHash(value), false)
})

test('P1: the lock that serialises a purchase key is named by the fingerprint and by nothing else', () => {
  const hash = purchaseKeyFor(strong(9)) as string
  assert.equal(purchaseKeyLockName(hash), `checkout:purchase-key:${hash}`)
  assert.throws(() => purchaseKeyLockName('not a fingerprint'))
})

// ---- P2 -----------------------------------------------------------------------------------------------------------------------------
test('P2: the owner of an order is shown by the same non-null session hash, or by the access cookie of THAT order - nothing else, and never for an account order', () => {
  const mine = sha256('my-session')
  const order = (over: Record<string, unknown> = {}) => ({ id: 'order-1', userId: null as string | null, guestSessionHash: mine as string | null, ...over })
  const none = new Set<string>()
  const some = new Set(['order-1'])
  const other = new Set(['order-2', 'order-3'])
  // the session
  assert.equal(ownershipProof(order(), mine, none), 'session')
  assert.equal(ownershipProof(order(), sha256('another-session'), none), null)
  assert.equal(ownershipProof(order(), mine, other), 'session', 'the session is enough, the other ids are beside the point')
  // the access cookie
  assert.equal(ownershipProof(order(), sha256('another-session'), some), 'access')
  assert.equal(ownershipProof(order(), sha256('another-session'), other), null, 'a cookie for ANOTHER order proves nothing about this one')
  assert.equal(ownershipProof(order({ guestSessionHash: null }), mine, some), 'access')
  // a session hash that is missing is never a proof - on either side
  assert.equal(ownershipProof(order({ guestSessionHash: null }), mine, none), null)
  assert.equal(ownershipProof(order({ guestSessionHash: null }), null, none), null)
  assert.equal(ownershipProof(order({ guestSessionHash: null }), '', none), null)
  assert.equal(ownershipProof(order({ guestSessionHash: null }), undefined, none), null)
  assert.equal(ownershipProof(order({ guestSessionHash: '' }), '', none), null, 'two empty strings are not a match')
  assert.equal(ownershipProof(order(), null, none), null)
  assert.equal(ownershipProof(order(), '', none), null)
  // an account's order belongs to the account: neither a session nor an access cookie opens it
  assert.equal(ownershipProof(order({ userId: 'user-1' }), mine, none), null)
  assert.equal(ownershipProof(order({ userId: 'user-1' }), mine, some), null)
  assert.equal(ownershipProof(order({ userId: 'user-1', guestSessionHash: null }), mine, some), null)
})

test('P2: the comparison is exact - a hash that differs by one character, by case or by padding is another browser', () => {
  const mine = sha256('my-session')
  const order = { id: 'o', userId: null, guestSessionHash: mine }
  for (const near of [`${mine.slice(0, 63)}${mine.endsWith('0') ? '1' : '0'}`, mine.toUpperCase(), `${mine} `, ` ${mine}`, mine.slice(0, 63), `${mine}0`]) {
    assert.equal(ownershipProof(order, near, new Set()), null, near)
  }
})

// ---- P3 -----------------------------------------------------------------------------------------------------------------------------
test('P3: the internal classification is one of three things - in doubt first, then paid, and anything else is "started": the default is to refuse', () => {
  const facts = (over: Partial<{ paymentStatus: string; paidAtPresent: boolean; inDoubt: boolean }> = {}) => ({ paymentStatus: 'pending', paidAtPresent: false, inDoubt: false, ...over })
  assert.equal(classifyForeignPurchase(facts({ inDoubt: true })), 'in_doubt')
  assert.equal(classifyForeignPurchase(facts({ inDoubt: true, paymentStatus: 'paid', paidAtPresent: true })), 'in_doubt', 'in doubt wins over paid')
  assert.equal(classifyForeignPurchase(facts({ paymentStatus: 'paid' })), 'paid')
  assert.equal(classifyForeignPurchase(facts({ paymentStatus: 'free' })), 'paid')
  assert.equal(classifyForeignPurchase(facts({ paidAtPresent: true })), 'paid', 'a payment that was verified once stays "paid" whatever happened to the status since')
  assert.equal(classifyForeignPurchase(facts({ paymentStatus: 'refunded', paidAtPresent: true })), 'paid')
  for (const paymentStatus of ['pending', 'canceled', 'cancelled', 'failed', 'expired', 'unpaid', 'requires_payment_method', '', 'anything-new']) {
    assert.equal(classifyForeignPurchase(facts({ paymentStatus })), 'started', `${paymentStatus}: not paid, not in doubt: started - never "free to buy again"`)
  }
})

test('P3: the verdict is total and has no way out - every combination of the facts gives one of the three', () => {
  const allowed = new Set<PurchaseVerdict>(['paid', 'in_doubt', 'started'])
  const seen = new Set<string>()
  for (const paymentStatus of ['pending', 'processing', 'paid', 'free', 'canceled', 'failed', 'refunded', 'weird', '']) {
    for (const paidAtPresent of [true, false]) {
      for (const inDoubt of [true, false]) {
        const verdict = classifyForeignPurchase({ paymentStatus, paidAtPresent, inDoubt })
        assert.ok(allowed.has(verdict), `${paymentStatus}/${paidAtPresent}/${inDoubt} -> ${verdict}`)
        seen.add(verdict)
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['in_doubt', 'paid', 'started'])
  // inputs that are not what the type says do not throw and do not open anything
  for (const bad of [undefined, null, {}, { paymentStatus: 7 }, { inDoubt: 'yes' }]) {
    let verdict: unknown = 'not called'
    assert.doesNotThrow(() => { verdict = classifyForeignPurchase(bad as any) })
    assert.ok(allowed.has(verdict as PurchaseVerdict), `${JSON.stringify(bad)} -> ${String(verdict)}`)
  }
})

test('P3: nothing is "closed" - there is no such verdict, no such code and no way to reach one, in the code that decides (R3: no automatic unlocking before the reconciliation work)', () => {
  const files = ['lib/purchase-intent.ts', 'lib/checkout-orders.ts', 'app/api/checkout/session/route.ts', 'lib/checkout-client.ts', 'lib/checkout-copy.ts']
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8')
    assert.equal(/PURCHASE_CLOSED|purchase_closed/.test(source), false, `${file}: no PURCHASE_CLOSED`)
    assert.equal(/['"]closed['"]/.test(source.replace(/\/\/.*$/gm, '')), false, `${file}: no verdict called closed`)
  }
})

// ---- P4 -----------------------------------------------------------------------------------------------------------------------------
test('P4: the support code is the first ten hex digits of the fingerprint, in capitals, as XXXXX-XXXXX - and never the whole fingerprint', () => {
  assert.match('0123A-BCDEF', SUPPORT_CODE_PATTERN)
  for (const bad of ['0123a-bcdef', '0123A-BCDE', '0123A-BCDEFG', '0123ABCDEF', '0123A_BCDEF', '0123G-BCDEF', ' 0123A-BCDEF', '0123A-BCDEF\n']) assert.doesNotMatch(bad, SUPPORT_CODE_PATTERN, bad)
  for (let seed = 0; seed < 50; seed++) {
    const hash = purchaseKeyFor(strong(seed)) as string
    const code = supportCodeFor(hash)
    assert.match(code, SUPPORT_CODE_PATTERN)
    assert.equal(code, `${hash.slice(0, 5)}-${hash.slice(5, 10)}`.toUpperCase())
    assert.ok(code.length === 11 && hash.length === 64, 'ten digits out of sixty-four')
    assert.equal(supportCodeFor(hash), code, 'deterministic')
  }
  assert.throws(() => supportCodeFor('not a fingerprint'))
  assert.throws(() => supportCodeFor(''))
})

// ---- P5 -----------------------------------------------------------------------------------------------------------------------------
test('P5: there is ONE refusal - 409, one code, one sentence that says nothing about the purchase (not money, not its state, not whose it is) and carries nothing that belongs to somebody', () => {
  const refusal = purchaseRefusal()
  assert.deepEqual(Object.keys(refusal).sort(), ['code', 'message', 'status'])
  assert.equal(refusal.status, 409)
  assert.equal(refusal.code, 'PURCHASE_KEY_IN_USE')
  assert.equal(PURCHASE_REFUSAL_CODE, refusal.code)
  assert.ok(refusal.message.length > 20 && refusal.message.length < 200, refusal.message)
  assert.equal(/[0-9a-f]{12,}|\bMW-\d|\bcl[a-z0-9]{20,}\b|order\s*(id|number)/i.test(refusal.message), false, `no identifier in: ${refusal.message}`)
  // S-01: nothing that tells what happened to the purchase the key is tied to
  assert.equal(/paid|payment|confirm|review|cancel|expir|fail|doubt|progress|conclu|complet|refund|charge|started|pending/i.test(`${refusal.message} ${refusal.code}`), false, `nothing about the state: ${refusal.message}`)
})

test('P5: a refusal is handed out as a COPY - whoever changes the answer of one request changes nothing for the next', () => {
  const first = purchaseRefusal() as any
  const { code, message } = first
  first.code = 'SOMETHING_ELSE'
  first.message = 'changed'
  first.status = 200
  first.orderId = 'an-order'
  const next = purchaseRefusal()
  assert.notEqual(next, first)
  assert.deepEqual(next, { status: 409, code, message })
})

test('P5: the codes of the first version of R1-1b, one for each state of the purchase, are gone from every file that answers (S-01): the answer does not depend on the state, so the code cannot name it', () => {
  for (const file of ['lib/purchase-intent.ts', 'lib/checkout-orders.ts', 'app/api/checkout/session/route.ts', 'lib/checkout-client.ts', 'lib/checkout-copy.ts']) {
    const source = readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.equal(/PURCHASE_ALREADY_PAID|PURCHASE_ALREADY_STARTED|purchase_started_elsewhere|purchase_already_paid|refusalFor/.test(source), false, file)
  }
})

// ---- P6 -----------------------------------------------------------------------------------------------------------------------------
test('P6: the module is pure - it imports only the hash function and the key-shape filter, and reads no clock, no environment, no random source, no network, no database', () => {
  const source = readFileSync(path.join(root, 'lib/purchase-intent.ts'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const imports = [...code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]).sort()
  assert.deepEqual(imports, ['@/lib/checkout-key-format', 'node:crypto'], `imports: ${imports.join(', ')}`)
  for (const forbidden of [/\bDate\b/, /\bprocess\b/, /Math\.random/, /\bfetch\b/, /\bprisma\b/i, /\bstripe\b/i, /\brequire\(/, /\bsetTimeout\b/, /\bperformance\b/, /\bconsole\b/, /randomBytes|randomUUID|getRandomValues/]) {
    assert.equal(forbidden.test(code), false, `forbidden: ${forbidden}`)
  }
})
