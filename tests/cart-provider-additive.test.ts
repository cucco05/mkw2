// R1-2 (DR4-1) – the only change allowed in components/cart/CartProvider.tsx is the addition of `clearIf`: an import, a type member, one block, one member of the value. Nothing that was
// there is changed - not `clear`, not the effect that saves the cart, not the `storage` listener, not the initial load, not one of the functions that change the lines.
//
// How this is shown without git: the additions are cut out of the file as it is now, and what is left must be, byte for byte, the file as it was when this change started (commit
// 457df91, SHA-256 below). If the file differs from it in any other way, this test fails and says so; changing the provider on purpose means changing the hash on purpose, in the
// open, with a reason in the commit.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const FILE = path.join(process.cwd(), 'components/cart/CartProvider.tsx')
// components/cart/CartProvider.tsx at 457df9149da560d8b68fb07b3c9d89aa619a034c (21015 bytes)
const APPROVED_SHA256 = 'eb757e6de76741f3cda4f3605b993a2cd893a63dbf38ca0876cb018b00dfe636'
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const IMPORT = "import { createClearIfEngine, type ClearIfEngine, type ClearIfResult } from '@/lib/cart-clear-if'\n"
const TYPE_MEMBER = /  \/\/ \(R1-2\) Empties the cart ONLY if [^\n]*\n(?:  \/\/ [^\n]*\n)*  clearIf: \(matches: \(items: readonly CartItem\[\]\) => boolean, options\?: \{ waitMs\?: number \}\) => Promise<ClearIfResult>\n/
const BLOCK = /  \/\/ \(R1-2\) `clearIf`\. [^\n]*\n(?:  \/\/ [^\n]*\n)*  const \[clearTick, setClearTick\] = useState\(0\)\n[\s\S]*?  useEffect\(\(\) => \(\) => \{ clearIfEngine\.current\?\.cancelAll\(\) \}, \[\]\)\n\n/
const VALUE_MEMBER = '    clearIf,\n'
const VALUE_DEPS = ', clear, clearIf])'

function withoutTheAddition(text: string) {
  const cuts: Array<[string, (t: string) => string]> = [
    ['the import', (t) => t.replace(IMPORT, '')],
    ['the type member (with its comment)', (t) => t.replace(TYPE_MEMBER, '')],
    ['the clearIf block (state, ref, callback, two effects, with its comment)', (t) => t.replace(BLOCK, '')],
    ['the member of the value', (t) => t.replace(VALUE_MEMBER, '')],
    ['clearIf in the dependencies of the value', (t) => t.replace(VALUE_DEPS, ', clear])')],
  ]
  let out = text
  for (const [what, cut] of cuts) {
    const next = cut(out)
    assert.notEqual(next, out, `${what} is not where the change put it`)
    out = next
  }
  return { out, removedBytes: text.length - out.length }
}

test('DR4-1: cut the clearIf addition out of CartProvider.tsx and what is left is the approved file, byte for byte', () => {
  const current = readFileSync(FILE, 'utf8')
  const { out } = withoutTheAddition(current)
  assert.equal(sha256(out), APPROVED_SHA256, 'something other than the clearIf addition was changed in components/cart/CartProvider.tsx')
})

test('DR4-1: the addition is small - one import, one type member, one block, one member of the value', () => {
  const current = readFileSync(FILE, 'utf8')
  const { out } = withoutTheAddition(current)
  const added = current.split('\n').length - out.split('\n').length
  assert.ok(added > 0 && added <= 40, `the addition is ${added} lines`)
  // the one place the addition touches an existing line is the list of dependencies of the value
  assert.equal((current.match(/clearIf/g) ?? []).length >= 8, true)
})

test('DR4-1: what must not change is in the approved file - the lines that save the cart, follow the other tabs, and empty it', () => {
  // a guard against the hash above being updated by someone who did not read what it protects
  const current = readFileSync(FILE, 'utf8')
  for (const needle of [
    'const clear = useCallback(() => setItems([]), [])',
    "localStorage.setItem(STORAGE_KEY, json)",
    "window.addEventListener('storage', onStorage)",
    'if (raw !== null && raw === lastWritten.current) return',
    '}, [items, ready])',
  ]) assert.ok(current.includes(needle), needle)
})
