// Helpers of the static guards (tests/production-release-guards.test.ts): they read the SOURCE of the application - no database, no network - and answer questions such as
// "which keys does this prisma.printOrder.update(...) write?". A scanner with the rules of JavaScript strings, template literals, regular expressions and brackets, not a regex
// over text: a parenthesis inside a string must not end a call early, and a comment must not count as code.
// (Not a test file: its name does not match the test patterns.)

// ---- comments -------------------------------------------------------------------------------------------------------------------------------------------------------
// The text without its comments. Strings and template literals are kept as they are (a "//" inside a URL is not a comment).
export function stripComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i, ch)
      out += text.slice(i, end + 1)
      i = end + 1
    } else if (ch === '`') {
      const end = skipTemplate(text, i)
      out += text.slice(i, end + 1)
      i = end + 1
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      out += ' '
    } else if (ch === '/' && regexCanStart(text, i)) {
      const end = skipRegex(text, i)
      out += text.slice(i, end + 1)
      i = end + 1
    } else {
      out += ch
      i++
    }
  }
  return out
}

// ---- lexical pieces -------------------------------------------------------------------------------------------------------------------------------------------------
function skipString(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === quote || text[i] === '\n') return i
  }
  return text.length - 1
}
// `start` is the opening backtick; returns the index of the closing one. "${...}" is matched with its own brackets (it may hold strings and templates).
function skipTemplate(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i++; continue }
    if (ch === '`') return i
    if (ch === '$' && text[i + 1] === '{') {
      const end = matchClose(text, i + 1)
      if (end === -1) return text.length - 1
      i = end
    }
  }
  return text.length - 1
}
// Does a "/" at this place open a regular expression (and not divide)? It does when the last significant character before it can not end an expression.
function regexCanStart(text: string, index: number): boolean {
  let i = index - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  if (i < 0) return true
  const prev = text[i]
  if ('(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true
  // a keyword before it: return / typeof / case ...
  const word = text.slice(Math.max(0, i - 8), i + 1).match(/[A-Za-z]+$/)?.[0]
  return word === 'return' || word === 'typeof' || word === 'case' || word === 'in' || word === 'of'
}
function skipRegex(text: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i++; continue }
    if (ch === '\n') return i
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return i
  }
  return text.length - 1
}

// `open` is the index of "(", "{" or "["; returns the index of its closing bracket (-1 when the text ends first).
export function matchClose(text: string, open: number): number {
  const closers: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = []
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipString(text, i, ch); continue }
    if (ch === '`') { i = skipTemplate(text, i); continue }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 1; continue }
    if (ch === '/' && regexCanStart(text, i)) { i = skipRegex(text, i); continue }
    if (closers[ch]) { stack.push(closers[ch]); continue }
    if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

export const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

// ---- calls ------------------------------------------------------------------------------------------------------------------------------------------------------------
export type CallSite = { index: number; line: number; name: string; args: string }
// Every call whose opening matches `opening` (a regex that ENDS with the "(" of the call, e.g. /\bprintOrder\.(update|updateMany|upsert)\s*\(/g). `text` should have no comments.
export function callSites(text: string, opening: RegExp): CallSite[] {
  const flags = opening.flags.includes('g') ? opening.flags : `${opening.flags}g`
  const re = new RegExp(opening.source, flags)
  const found: CallSite[] = []
  for (const match of text.matchAll(re)) {
    const open = (match.index as number) + match[0].length - 1
    const close = matchClose(text, open)
    if (close === -1) continue
    found.push({ index: match.index as number, line: lineOf(text, match.index as number), name: match[0].replace(/\s*\($/, ''), args: text.slice(open + 1, close) })
  }
  return found
}

// ---- object literals --------------------------------------------------------------------------------------------------------------------------------------------------
export type Property = { key: string; computed: boolean; shorthand: boolean; value: string }
export type ObjectShape = { properties: Property[]; spreads: string[] }
// `text` starts with "{" (leading whitespace is ignored). Returns null when it is not an object literal.
export function objectShape(text: string): ObjectShape | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  const close = matchClose(trimmed, 0)
  if (close === -1) return null
  const body = trimmed.slice(1, close)
  const segments: string[] = []
  let depthStart = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '"' || ch === "'") { i = skipString(body, i, ch); continue }
    if (ch === '`') { i = skipTemplate(body, i); continue }
    if (ch === '/' && body[i + 1] === '/') { while (i < body.length && body[i] !== '\n') i++; continue }
    if (ch === '/' && body[i + 1] === '*') { const end = body.indexOf('*/', i + 2); i = end === -1 ? body.length : end + 1; continue }
    if (ch === '/' && regexCanStart(body, i)) { i = skipRegex(body, i); continue }
    if (ch === '(' || ch === '{' || ch === '[') { const end = matchClose(body, i); if (end === -1) break; i = end; continue }
    if (ch === ',') { segments.push(body.slice(depthStart, i)); depthStart = i + 1 }
  }
  segments.push(body.slice(depthStart))
  const properties: Property[] = []
  const spreads: string[] = []
  for (const raw of segments) {
    const segment = raw.trim()
    if (!segment) continue
    if (segment.startsWith('...')) { spreads.push(segment.slice(3).trim()); continue }
    if (segment.startsWith('[')) {
      const end = matchClose(segment, 0)
      const rest = segment.slice(end + 1).trim()
      properties.push({ key: segment.slice(0, end + 1), computed: true, shorthand: false, value: rest.startsWith(':') ? rest.slice(1).trim() : rest })
      continue
    }
    const keyMatch = segment.match(/^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*)|(\d+))/)
    if (!keyMatch) { properties.push({ key: segment, computed: true, shorthand: false, value: '' }); continue }
    const key = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3] ?? keyMatch[4]
    const rest = segment.slice(keyMatch[0].length).trim()
    if (rest.startsWith(':')) properties.push({ key, computed: false, shorthand: false, value: rest.slice(1).trim() })
    else properties.push({ key, computed: false, shorthand: true, value: key })
  }
  return { properties, spreads }
}
export const propertyOf = (shape: ObjectShape | null, key: string) => shape?.properties.find((property) => property.key === key) ?? null
