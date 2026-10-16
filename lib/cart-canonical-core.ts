// The part of the cart fingerprint that needs no `crypto`, so the browser can use it too (lib/checkout-client.ts): which lines are the same purchase.
// The server's fingerprint (lib/cart-canonical.ts) names a group with a SHA-256; the browser's memory of "this cart was sent to the payment page" uses a
// small non-cryptographic hash, which is enough there (it only has to recognise the customer's own cart again).
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

type CartLineLike = { setKey?: string | null | undefined } & Record<string, unknown>

export function canonicalCartItemsWith(items: ReadonlyArray<CartLineLike>, hashText: (text: string) => string): unknown[] {
  const cores = items.map((item) => {
    const { setKey, ...core } = item
    return { key: setKey ? String(setKey) : null, core, text: canonicalJson(core) }
  })
  // a group is named by the content of its lines, not by its key or by where its lines are
  const members = new Map<string, string[]>()
  for (const entry of cores) if (entry.key) members.set(entry.key, [...(members.get(entry.key) ?? []), entry.text])
  const labelOf = new Map<string, string>()
  for (const [key, texts] of members) labelOf.set(key, hashText(texts.slice().sort().join('\n')))
  return cores
    .map((entry) => (entry.key ? { ...entry.core, group: labelOf.get(entry.key) } : entry.core))
    .sort((a, b) => {
      const x = canonicalJson(a)
      const y = canonicalJson(b)
      return x < y ? -1 : x > y ? 1 : 0
    })
}

// A 53-bit string hash (cyrb53), as hexadecimal. NOT for security.
export function smallHash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}
