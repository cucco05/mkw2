// The cart side of "one complete copy of a model made of several parts" (step 4.6). Pure functions on cart lines, no React and no browser, so every rule is
// tested in node (tests/cart-groups.test.ts).
//
// A GROUP is the set of lines that carry the same `setKey`: one line per part, one quantity, one size. The browser keeps that true for everything the
// customer can do (quantity, size, removing, splitting); the SERVER does not rely on it and checks the claim again (lib/sale-units.ts).
//   * quantity and size (scale, lock, per-axis sizes) belong to the GROUP: changing them on one line changes them on every line of the group, because a
//     model whose parts are different sizes is not a model that fits together;
//   * colour, material, finish, infill, tolerance and engraving stay PER PART;
//   * a group is never half-removed: removing one line of it dissolves the group (the other lines become single parts), and removing the group removes all.

export const SET_KEY_PATTERN = /^[A-Za-z0-9_-]{8,40}$/

// What these functions need to know about a cart line (the real CartItem has more).
export type GroupableLine = {
  cartItemId: string
  modelId: string
  partId?: string | null
  setKey?: string | null
  options: {
    qty: number
    scale: number
    lockDimensions?: boolean
    dimensionOverrides?: Partial<Record<string, number | null>> | null
    productTemplateId?: string | null
    lockedConfig?: boolean
  }
}

// A fresh key, `s` + 16 URL-safe characters of randomness. `random` is injectable for tests.
export function newSetKey(randomBytes: (length: number) => Uint8Array = defaultRandomBytes): string {
  const bytes = randomBytes(12)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  const encoded = (typeof btoa === 'function' ? btoa(text) : Buffer.from(text, 'binary').toString('base64')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `s${encoded}`
}
function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

export const keyOf = (line: { setKey?: string | null }): string | null => (line.setKey && SET_KEY_PATTERN.test(line.setKey) ? line.setKey : null)

export function groupMembers<T extends GroupableLine>(items: ReadonlyArray<T>, setKey: string | null | undefined): T[] {
  if (!setKey) return []
  return items.filter((item) => keyOf(item) === setKey)
}

// The distinct groups of a cart, in the order of their first line, each with its lines.
export function groupsOf<T extends GroupableLine>(items: ReadonlyArray<T>): Array<{ setKey: string; lines: T[] }> {
  const seen = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    seen.set(key, [...(seen.get(key) ?? []), item])
  }
  return Array.from(seen, ([setKey, lines]) => ({ setKey, lines }))
}

// Same size on every axis, to four decimals (the server compares the same way).
function sizeKey(line: GroupableLine): string {
  const locked = line.options.lockDimensions !== false
  const overrides = locked ? null : line.options.dimensionOverrides
  const axis = (name: string) => {
    const value = overrides?.[name]
    return Number((typeof value === 'number' && Number.isFinite(value) ? value : line.options.scale).toFixed(4))
  }
  return [axis('x'), axis('y'), axis('z')].join('/')
}

// Quantity and size travel together inside a group: copy them from `source` to every other line with the same key.
export function propagateGroup<T extends GroupableLine>(items: T[], source: T | undefined): T[] {
  const key = source ? keyOf(source) : null
  if (!source || !key) return items
  return items.map((item) => {
    if (item === source || item.cartItemId === source.cartItemId || keyOf(item) !== key) return item
    return {
      ...item,
      options: {
        ...item.options,
        qty: source.options.qty,
        scale: source.options.scale,
        lockDimensions: source.options.lockDimensions,
        dimensionOverrides: source.options.dimensionOverrides ? { ...source.options.dimensionOverrides } : source.options.dimensionOverrides ?? null,
      },
    }
  })
}

// Take the key away from the lines of a group: they stay in the cart as single parts.
export function dissolveGroup<T extends GroupableLine>(items: T[], setKey: string | null | undefined): T[] {
  if (!setKey) return items
  return items.map((item) => (keyOf(item) === setKey ? { ...item, setKey: null } : item))
}

// Remove one line. If it belonged to a group the group can no longer be a complete copy: the lines left become single parts.
export function removeLine<T extends GroupableLine>(items: T[], matchesLine: (item: T) => boolean): T[] {
  const gone = items.filter(matchesLine)
  let next = items.filter((item) => !matchesLine(item))
  for (const line of gone) {
    const key = keyOf(line)
    if (key) next = dissolveGroup(next, key)
  }
  return next
}

export function removeGroup<T extends GroupableLine>(items: T[], setKey: string | null | undefined): T[] {
  if (!setKey) return items
  return items.filter((item) => keyOf(item) !== setKey)
}

// What a count of "things in the cart" should be: every group is ONE copy per quantity, however many parts it has.
export function countUnits<T extends GroupableLine>(items: ReadonlyArray<T>): number {
  const counted = new Set<string>()
  let total = 0
  for (const item of items) {
    const key = keyOf(item)
    if (key) {
      if (counted.has(key)) continue
      counted.add(key)
    }
    total += item.options.qty || 0
  }
  return total
}

export type GroupingCheck =
  | { ok: true; modelId: string; partCount: number; qty: number }
  | { ok: false; reason: 'TOO_FEW' | 'OTHER_MODELS' | 'NOT_PARTS' | 'ALREADY_GROUPED' | 'DUPLICATE_PART' | 'QTY_DIFFERS' | 'SIZE_DIFFERS' }

// May these loose lines be put together as ONE complete copy? The browser can check only what it can see (the lines); that they cover EVERY part of the
// model is what the server says (`COULD_BE_COMPLETE_MODEL`) and checks again. The lines must be parts of one model, each part once, the same quantity
// and the same size - nothing is adjusted on the customer's behalf.
export function checkGrouping<T extends GroupableLine>(items: ReadonlyArray<T>, cartItemIds: ReadonlyArray<string>): GroupingCheck {
  const chosen = cartItemIds.map((id) => items.find((item) => item.cartItemId === id)).filter((item): item is T => Boolean(item))
  if (chosen.length < 2 || chosen.length !== new Set(cartItemIds).size) return { ok: false, reason: 'TOO_FEW' }
  if (new Set(chosen.map((line) => line.modelId)).size !== 1) return { ok: false, reason: 'OTHER_MODELS' }
  if (chosen.some((line) => !line.partId || line.options.productTemplateId || line.options.lockedConfig)) return { ok: false, reason: 'NOT_PARTS' }
  if (chosen.some((line) => keyOf(line))) return { ok: false, reason: 'ALREADY_GROUPED' }
  if (new Set(chosen.map((line) => line.partId)).size !== chosen.length) return { ok: false, reason: 'DUPLICATE_PART' }
  if (new Set(chosen.map((line) => line.options.qty)).size !== 1) return { ok: false, reason: 'QTY_DIFFERS' }
  if (new Set(chosen.map(sizeKey)).size !== 1) return { ok: false, reason: 'SIZE_DIFFERS' }
  return { ok: true, modelId: chosen[0].modelId, partCount: chosen.length, qty: chosen[0].options.qty }
}

// Put the chosen loose lines under one new key. Refused (the cart is returned unchanged) when `checkGrouping` says no.
export function groupLines<T extends GroupableLine>(items: T[], cartItemIds: ReadonlyArray<string>, makeKey: () => string = newSetKey): T[] {
  if (!checkGrouping(items, cartItemIds).ok) return items
  const key = makeKey()
  const chosen = new Set(cartItemIds)
  return items.map((item) => (chosen.has(item.cartItemId) ? { ...item, setKey: key } : item))
}

// The group (if any) that already holds exactly these parts of this model with the same options per part: adding the model again then adds a copy to it.
// `sameOptions(existing, incoming)` is given by the caller (it knows how options are compared).
export function findGroupFor<T extends GroupableLine>(
  items: ReadonlyArray<T>,
  modelId: string,
  partIds: ReadonlyArray<string>,
  sameOptions: (existing: T, partId: string) => boolean,
): string | null {
  const wanted = new Set(partIds)
  if (wanted.size !== partIds.length || wanted.size === 0) return null
  for (const group of groupsOf(items)) {
    if (group.lines.length !== wanted.size) continue
    if (!group.lines.every((line) => line.modelId === modelId && line.partId && wanted.has(line.partId) && sameOptions(line, line.partId))) continue
    if (new Set(group.lines.map((line) => line.partId)).size !== wanted.size) continue
    return group.setKey
  }
  return null
}

// The order the cart shows its lines in: the lines of a group together (at the place of its first line), everything else as it is. Display only - the order of
// the cart itself, and of the request sent to the server, is not changed.
export function orderForDisplay<T extends GroupableLine>(items: ReadonlyArray<T>): T[] {
  const out: T[] = []
  const placed = new Set<string>()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) { out.push(item); continue }
    if (placed.has(key)) continue
    placed.add(key)
    out.push(...groupMembers(items, key))
  }
  return out
}
