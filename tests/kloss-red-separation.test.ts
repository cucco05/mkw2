// R1-3 / KLOSS - P0: the RED proofs stay RED and stay APART until P2 of the plan, and none of them is lost.
//
// tests/red/kloss/*.red.ts describe defects of the checkout that are not corrected yet. They must not turn the ordinary suites red, and they must not disappear or be moved into them by accident:
//   * their extension matches no pattern of `npm test` (node's default discovery) nor of `npm run test:security` (tests/security/*.sec.ts); they have a script of their own;
//   * every one of them has a stable id in its title and a row in tests/red/kloss/RED-LEDGER.md (expected result, actual result, cause) - deleting or renaming one fails here;
//   * so do the controls (tests/security/kloss-controls.sec.ts), which are ordinary green tests.
// When P2 corrects a defect its RED test is moved into the ordinary suite, its id leaves this list and the ledger row is closed - in the same change.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const RED_DIR = 'tests/red/kloss'
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

const RED_IDS = [
  'KL-D1-price', 'KL-D1-uncertain', 'KL-D1-stale', 'KL-D1-concurrent', 'KL-HOLD-uniform', 'KL-A-legacy', 'KL-A-unreachable', 'KL-B-paid-hidden',
  'KL-D2-window', 'KL-D3-account', 'KL-D3-cookie', 'KL-D3-confirm', 'KL-D-cookie', 'KL-E1-concurrent', 'KL-LOCK-owner',
] as const
const CONTROL_IDS = [
  'KL-C-paid', 'KL-C-cancelled', 'KL-D2-ctrl', 'KL-D3-ctrl-session', 'KL-D3-ctrl-account', 'KL-F-independent', 'KL-G-invalid-cookies', 'KL-E2-limit', 'KL-LK-legacy-locks',
] as const
// the variants a loop turns into several tests (the source must still carry each of them)
const VARIANTS: Record<string, string[]> = {
  'KL-D1-uncertain': ["stripeSessionId: null", "failureReason: 'payment_failed'"],
  'KL-A-legacy': ["[null, 'session_mismatch:amount', 'stale_reservation']"],
}

test('KLOSS RED: no ordinary suite picks them up, and only their own script runs them', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
  assert.equal(scripts.test, 'node --test --import tsx', 'npm test is unchanged (node\'s default discovery)')
  assert.ok(scripts['test:security'].endsWith('tests/security/*.sec.ts') && !scripts['test:security'].includes('red'), 'the security suite is unchanged')
  assert.equal(scripts['test:kloss-red'], 'node --test --test-concurrency=1 --import tsx tests/red/kloss/*.red.ts', 'the RED proofs have a script of their own')
  const files = readdirSync(path.join(ROOT, RED_DIR))
  const tests = files.filter((name) => name.endsWith('.ts'))
  assert.ok(tests.length >= 3, 'the RED files are there')
  for (const name of tests) {
    assert.ok(name.endsWith('.red.ts'), `${name}: a RED file is named *.red.ts`)
    assert.equal(/(\.test|-test|_test|\.sec)\.[cm]?[jt]sx?$|^test-|^test\.[cm]?[jt]sx?$/.test(name), false, `${name}: matches a pattern of an ordinary suite`)
  }
  // nothing under a directory called `test/`, which node's default discovery also reads
  assert.equal(RED_DIR.split('/').includes('test'), false)
})

test('KLOSS RED: every proof is still there, with a stable id, and has its row in the ledger', () => {
  const sources = readdirSync(path.join(ROOT, RED_DIR)).filter((name) => name.endsWith('.red.ts')).map((name) => read(`${RED_DIR}/${name}`)).join('\n')
  const ledger = read(`${RED_DIR}/RED-LEDGER.md`)
  for (const id of RED_IDS) {
    assert.ok(sources.includes(`[${id}]`), `${id}: the RED test is gone or its id was changed`)
    assert.ok(ledger.includes(`\`${id}\``), `${id}: the ledger has no row for it`)
  }
  for (const [id, markers] of Object.entries(VARIANTS)) for (const marker of markers) assert.ok(sources.includes(marker), `${id}: the variant ${marker} is gone`)
  // each RED test states what it expected and why it fails; none was turned into a passing assertion
  const withoutComments = sources.replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/\.skip\(|\{\s*skip:|\btest\.todo\(|\bonly\(/.test(withoutComments), false, 'no RED proof is skipped, marked todo or narrowed with `only`')
  assert.equal((withoutComments.match(/CAUSE:/g) ?? []).length >= RED_IDS.length, true, 'every RED message names its cause')
})

test('KLOSS controls: they are ordinary tests of the security suite and each has its row in the ledger', () => {
  const controls = read('tests/security/kloss-controls.sec.ts')
  const ledger = read(`${RED_DIR}/RED-LEDGER.md`)
  for (const id of CONTROL_IDS) {
    assert.ok(controls.includes(`[${id}]`), `${id}: the control is gone or its id was changed`)
    assert.ok(ledger.includes(`\`${id}\``), `${id}: the ledger has no row for it`)
  }
  assert.ok(controls.includes('NOT CLOSED'), 'the limit E2 is still written down as a limit that is not closed')
})
