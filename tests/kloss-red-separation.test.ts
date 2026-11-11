// R1-3 / KLOSS - the P0 proofs are never lost, never weakened, and each is where it belongs.
//
// P0 wrote eighteen proofs (fifteen ids) of defects of the checkout, RED on purpose and kept apart from the ordinary suites. P2 corrected the defects of fifteen of them (twelve ids): those are
// ORDINARY tests of the security suite now - same ids, same assertions - and run with CHECKOUT_OWNER_GUARD=on. The three proofs of D3 (the repeat purchase after a paid one) belong to P3: they
// are still RED and still apart. P3 (PLAN REV2) added, BEFORE any correction, three more proofs of D3 (a confirmation that names nothing; the same purchase made again through an order that
// already exists - by its own key, or as the order to continue) and one proof of the limit E2 (a guest who signs in), which is expected to stay RED after P3.
//   * a proof that is still RED has an extension that matches no pattern of `npm test` (node's default discovery) nor of `npm run test:security` (tests/security/*.sec.ts), and its own script;
//   * a proof that turned GREEN is in the security suite, with its id in the title and the EXPECTED VALUES of P0 still in its body (they are pinned here: turning an expectation into an easier
//     one, or dropping a variant, fails this test), with the guard switched on and nothing skipped;
//   * every proof and every control has its row in tests/red/kloss/RED-LEDGER.md; the limit E2 is still written down as a limit that is not closed.
// P3 corrected D3: its six proofs moved the same way (tests/security/kloss-repeat.sec.ts, with CHECKOUT_OWNER_GUARD=on and CHECKOUT_REPEAT_GUARD=on) - each id left STILL_RED and entered TURNED_GREEN
// with its pinned values, and its ledger row was closed, in the same change. KL-E2-login stays RED (the limit E2: closing it is P2b).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const RED_DIR = 'tests/red/kloss'
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')
const withoutComments = (source: string) => source.replace(/^\s*\/\/.*$/gm, '')

// the expected values of P0, as written in P0 (tests/red/kloss/*.red.ts at bc28cd9): what each proof asserts
const STILL_RED: Record<string, string[]> = {
  // (P3, audit point F: the limit E2 as a failing proof - it STAYS here after P3)
  'KL-E2-login': ['assert.deepEqual(seen, { payablePages: 1 },', 'viewer: { id: k.customer.id, role: \'customer\' }'],
}
const CROSS = 'tests/security/kloss-cross-order.sec.ts'
const SESSIONS = 'tests/security/kloss-sessions-and-locks.sec.ts'
const WINDOW = 'tests/security/kloss-window.sec.ts'
const REPEAT = 'tests/security/kloss-repeat.sec.ts'
const TURNED_GREEN: Record<string, { file: string; pinned: string[] }> = {
  'KL-D1-price': { file: CROSS, pinned: ['assert.deepEqual(seen, { secondStatus: 409, orders: 1, payablePages: 1, providerSessions: 1 },'] },
  'KL-D1-uncertain': { file: CROSS, pinned: ["mutate: { status: 'creating', stripeSessionId: null }", "mutate: { status: 'expired', failureReason: 'payment_failed' }", 'assert.deepEqual(seen, { secondStatus: 409, orders: 1, payablePages: 1, providerSessions: 1 },'] },
  'KL-D1-stale': { file: CROSS, pinned: ['assert.deepEqual(seen, { staleStatus: 409, payablePages: 1 },', 'const stale = await k.payAgain(first)'] },
  'KL-D1-concurrent': { file: CROSS, pinned: ['assert.deepEqual(seen, { secondWaitedForFirst: true, statuses: [200, 409], orders: 1, payablePages: 1, providerSessions: 1 },'] },
  'KL-HOLD-uniform': { file: CROSS, pinned: ['assert.deepEqual(seen, [descriptor(heldDoubt), descriptor(heldDoubt), descriptor(heldDoubt)],', 'assert.equal(heldDoubt.status, 409,', 'await cancelLikeTheOldCode(k, hidden, null)'] },
  'KL-A-legacy': { file: CROSS, pinned: ["for (const reason of [null, 'session_mismatch:amount', 'stale_reservation'])", 'seen.payable <= 1 && (seen.sessions === 1 || seen.closedBeforeCreate)', 'assert.equal(await noTwoPagesNorWithoutClosing(seen), true,'] },
  'KL-A-unreachable': { file: CROSS, pinned: ['k.sim.faults.expireUnreachable = 99', 'k.sim.faults.retrieveUnreachable = 99', 'assert.deepEqual(seen, { status: 409, providerSessions: 1, orders: 1, rowsUnchanged: true },'] },
  'KL-B-paid-hidden': { file: CROSS, pinned: ['assert.equal(seen.payable <= 1 && (closedFirst >= 0 || seen.sessions <= 2), true,', 'await k.addLegacyTwin(paid.orderId)'] },
  'KL-D2-window': { file: WINDOW, pinned: ['assert.deepEqual(seen, { status: 200, sameOrder: true, orders: 1, payablePages: 1 },', 'await k.travel(61 * MIN - (SESSION_TTL_MS - 30_000))'] },
  'KL-D-cookie': { file: SESSIONS, pinned: ["assert.deepEqual(seen, { status: 409, code: 'PAYMENT_IN_PROGRESS', named: first.orderId, orders: 1, payablePages: 1 },"] },
  'KL-E1-concurrent': { file: SESSIONS, pinned: ['assert.deepEqual(seen, { secondWaitedForFirst: true, statuses: [200, 409], orders: 2, payablePages: 1 },'] },
  'KL-LOCK-owner': { file: SESSIONS, pinned: ['`checkout:owner:h:${hash}:${cartFingerprint}`', 'assert.deepEqual({ waitedForTheOwnerLock: waits, afterwards: answer.status }, { waitedForTheOwnerLock: true, afterwards: 200 },'] },
  // GREEN since P3 (the values of P0 for the three proofs of P0; the values written RED in P3 for the other three)
  'KL-D3-account': { file: REPEAT, pinned: ["{ status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', orders: 1, providerSessions: 1 }"] },
  'KL-D3-cookie': { file: REPEAT, pinned: ["{ status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', named: first.orderId, orders: 1, providerSessions: 1 }"] },
  'KL-D3-confirm': { file: REPEAT, pinned: ['{ status: 200, repeatOf: [first.orderId] }', 'confirmRepeat: true', 'confirmRepeat: true, repeatContext: proposal.json?.repeatContext'] },
  'KL-D3-confirm-incomplete': {
    file: REPEAT,
    pinned: [
      "{ answers: [{ status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED' }, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED' }], orders: 1, providerSessions: 1 }",
      "checkoutKey: k.newKey('alone'), confirmRepeat: true }", "repeatContext: `rc1_${'0'.repeat(64)}`",
    ],
  },
  'KL-D3-stale-order': { file: REPEAT, pinned: ["{ status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', payablePages: 0, newSessions: 0 }", 'const stale = await k.payAgain(older)'] },
  'KL-D3-older-reuse': { file: REPEAT, pinned: ["{ status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', payablePages: 0, newSessions: 0, newKeyBound: 0 }"] },
}
// how many `test(` each file of turned-green proofs holds (two of them are loops: 11 + 3 + 1 = 15 tests of P2 when run; 6 of P3)
const GREEN_TEST_SITES: Record<string, number> = { [CROSS]: 8, [SESSIONS]: 3, [WINDOW]: 1, [REPEAT]: 6 }
const CONTROL_IDS = [
  'KL-C-paid', 'KL-C-cancelled', 'KL-D2-ctrl', 'KL-D3-ctrl-session', 'KL-D3-ctrl-account', 'KL-F-independent', 'KL-G-invalid-cookies', 'KL-E2-limit', 'KL-LK-legacy-locks',
] as const

test('KLOSS RED: the proofs that are still RED are picked up by no ordinary suite, and only their own script runs them', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
  assert.equal(scripts.test, 'node --test --import tsx', 'npm test is unchanged (node\'s default discovery)')
  assert.ok(scripts['test:security'].endsWith('tests/security/*.sec.ts') && !scripts['test:security'].includes('red'), 'the security suite is unchanged')
  assert.equal(scripts['test:kloss-red'], 'node --test --test-concurrency=1 --import tsx tests/red/kloss/*.red.ts', 'the RED proofs have a script of their own')
  const tests = readdirSync(path.join(ROOT, RED_DIR)).filter((name) => name.endsWith('.ts'))
  assert.ok(tests.length >= 1, 'the RED files are there')
  for (const name of tests) {
    assert.ok(name.endsWith('.red.ts'), `${name}: a RED file is named *.red.ts`)
    assert.equal(/(\.test|-test|_test|\.sec)\.[cm]?[jt]sx?$|^test-|^test\.[cm]?[jt]sx?$/.test(name), false, `${name}: matches a pattern of an ordinary suite`)
  }
  // nothing under a directory called `test/`, which node's default discovery also reads
  assert.equal(RED_DIR.split('/').includes('test'), false)
})

test('KLOSS RED: the proofs that are still RED are there, with their expected values (those of P0 for the three proofs of P0) and their rows in the ledger', () => {
  const sources = readdirSync(path.join(ROOT, RED_DIR)).filter((name) => name.endsWith('.red.ts')).map((name) => read(`${RED_DIR}/${name}`)).join('\n')
  const ledger = read(`${RED_DIR}/RED-LEDGER.md`)
  for (const [id, pinned] of Object.entries(STILL_RED)) {
    assert.ok(sources.includes(`[${id}]`), `${id}: the RED test is gone or its id was changed`)
    assert.ok(ledger.includes(`\`${id}\``), `${id}: the ledger has no row for it`)
    for (const text of pinned) assert.ok(sources.includes(text), `${id}: the expected value of P0 is gone or was changed: ${text}`)
  }
  // a RED proof is exactly the ones listed: nothing that turned green was left behind, nothing new hides here
  const ids = [...sources.matchAll(/test\(`?'?\[(KL-[A-Za-z0-9-]+)\]/g)].map((match) => match[1]).sort()
  assert.deepEqual(ids, Object.keys(STILL_RED).sort())
  const code = withoutComments(sources)
  assert.equal(/\.skip\(|\{\s*skip:|\btest\.todo\(|\bonly\(/.test(code), false, 'no RED proof is skipped, marked todo or narrowed with `only`')
  assert.equal((code.match(/CAUSE:/g) ?? []).length >= Object.keys(STILL_RED).length, true, 'every RED message names its cause')
  // a RED proof says what the checkout does when the guards are on too: it must not depend on a flag being off
  assert.equal(/CHECKOUT_OWNER_GUARD|CHECKOUT_REPEAT_GUARD/.test(code), false)
})

test('KLOSS GREEN since P2 and P3: the proofs that turned green are ordinary tests of the security suite, with their ids and expected values, the guards on and nothing skipped', () => {
  const ledger = read(`${RED_DIR}/RED-LEDGER.md`)
  const redSources = readdirSync(path.join(ROOT, RED_DIR)).filter((name) => name.endsWith('.red.ts')).map((name) => read(`${RED_DIR}/${name}`)).join('\n')
  for (const [id, { file, pinned }] of Object.entries(TURNED_GREEN)) {
    const source = read(file)
    assert.ok(file.endsWith('.sec.ts') && file.startsWith('tests/security/'), `${id}: it is in the ordinary security suite`)
    assert.ok(source.includes(`[${id}]`), `${id}: the test is gone from ${file} or its id was changed`)
    for (const text of pinned) assert.ok(source.includes(text), `${id}: an expected value or a variant of P0 is gone or was changed in ${file}: ${text}`)
    assert.ok(ledger.includes(`\`${id}\``), `${id}: the ledger has no row for it`)
    assert.equal(redSources.includes(`[${id}]`), false, `${id}: it is still among the RED proofs as well`)
  }
  for (const [file, sites] of Object.entries(GREEN_TEST_SITES)) {
    const code = withoutComments(read(file))
    assert.equal((code.match(/^\s*test\(/gm) ?? []).length, sites, `${file}: the number of tests changed`)
    assert.equal(/\.skip\(|\{\s*skip:|\btest\.todo\(|\bonly\(/.test(code), false, `${file}: nothing is skipped, marked todo or narrowed with \`only\``)
    assert.ok(code.includes("process.env.CHECKOUT_OWNER_GUARD = 'on'"), `${file}: the proofs run with the guard on`)
    if (file === REPEAT) assert.ok(code.includes("process.env.CHECKOUT_REPEAT_GUARD = 'on'"), `${file}: the proofs of P3 run with the repeat guard on`)
    assert.equal((code.match(/CAUSE:/g) ?? []).length >= sites, true, `${file}: every proof still names the cause it was RED for`)
  }
})

test('KLOSS controls: they are ordinary tests of the security suite - run with the guard off AND on - and each has its row in the ledger; E2 is still a limit', () => {
  const controls = read('tests/security/kloss-controls.sec.ts')
  const ledger = read(`${RED_DIR}/RED-LEDGER.md`)
  for (const id of CONTROL_IDS) {
    assert.ok(controls.includes(`[${id}]`), `${id}: the control is gone or its id was changed`)
    assert.ok(ledger.includes(`\`${id}\``), `${id}: the ledger has no row for it`)
  }
  assert.ok(controls.includes('NOT CLOSED'), 'the limit E2 is still written down as a limit that is not closed')
  assert.equal(/CHECKOUT_OWNER_GUARD/.test(withoutComments(controls)), false, 'the controls do not set the flag themselves: one file runs them with it off, another with it on')
  const on = withoutComments(read('tests/security/kloss-controls-on.sec.ts'))
  assert.ok(on.includes("process.env.CHECKOUT_OWNER_GUARD = 'on'") && on.includes("require('./kloss-controls.sec')"), 'the controls are run again with the guard on')
  assert.ok(/E2[^\n]*(limite|limit)/i.test(ledger) && /non (lo )?chiu/i.test(ledger), 'the ledger still says E2 is not closed')
})
