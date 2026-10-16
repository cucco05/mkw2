// What is actually SOLD, line by line: the unit of sale (step 4.6). Pure functions, no database.
//
// A cart line is a model and optionally ONE part of it. The commercial minimum (SiteConfig "Minimum price") is the least ONE SOLD
// UNIT may cost, so the server has to know which lines together make one unit. The database does not say it, and the browser's word is
// not enough, so the rule is explicit and checked:
//   * a whole model (no part), a ready-made product, a single-part model, or a part with no `setKey`   -> every copy is a unit of its own;
//   * lines that carry the same `setKey` claim to be ONE COMPLETE COPY of a multi-part model. They are believed ONLY when the claim can be
//     checked against what the server knows: every part of the model exactly once, the same quantity on every line (that quantity is the
//     number of complete copies), and the same scale on every axis (a model whose parts are different sizes is not a model that fits together).
//     Colours may differ.
//   * a claim that fails any check is NOT repaired and NOT guessed: its lines are sold as single parts, exactly as if they had no key, and
//     the answer says why (`SET_NOT_VALID`). Nothing here ever makes a cart cheaper than the lines as they stand.
//   * lines with no key that would make a complete model if grouped are only SUGGESTED (`COULD_BE_COMPLETE_MODEL`): the customer decides.

export type UnitLine = {
  // position of the line in the request
  index: number
  modelId: string
  partId: string | null
  productTemplateId: string | null
  setKey: string | null
  qty: number
  // the scales the SERVER worked out for the line (never the browser's claim)
  scaleX: number
  scaleY: number
  scaleZ: number
}

export type UnitKind = 'whole' | 'product' | 'part' | 'set'

export type SaleUnit = {
  kind: UnitKind
  // the lines (positions in the input) that make ONE copy of the unit, in the order of the request; a complete model has one per part
  lineIndexes: number[]
  // how many copies the lines stand for (their quantity)
  copies: number
  // sets only: 1, 2, ... in the order of the first line of each set
  setOrdinal: number | null
  // sets only: how many parts make a copy
  partCount: number
}

export type SetRejection =
  | 'KEY_ON_NON_PART'
  | 'KEY_ACROSS_MODELS'
  | 'DUPLICATE_PART'
  | 'FOREIGN_PART'
  | 'INCOMPLETE'
  | 'QTY_MISMATCH'
  | 'SCALE_MISMATCH'

export type UnitNotice =
  | { code: 'SET_NOT_VALID'; reason: SetRejection; itemIndexes: number[] }
  | { code: 'COULD_BE_COMPLETE_MODEL'; itemIndexes: number[]; copies: number }

export type SaleUnitPlan = {
  units: SaleUnit[]
  // for each input line (same position), the index in `units`
  unitOfLine: number[]
  notices: UnitNotice[]
}

// Scales are compared to four decimals: the browser derives them from one state, a difference smaller than that is not a different size.
const scaleKey = (line: UnitLine) => [line.scaleX, line.scaleY, line.scaleZ].map((value) => Math.round(value * 10_000)).join('/')

function rejectionOf(group: UnitLine[], allParts: ReadonlyArray<string>): SetRejection | null {
  const parts = group.map((line) => line.partId as string)
  if (new Set(parts).size !== parts.length) return 'DUPLICATE_PART'
  const known = new Set(allParts)
  if (parts.some((part) => !known.has(part))) return 'FOREIGN_PART'
  if (parts.length !== known.size) return 'INCOMPLETE'
  if (new Set(group.map((line) => line.qty)).size !== 1) return 'QTY_MISMATCH'
  if (new Set(group.map(scaleKey)).size !== 1) return 'SCALE_MISMATCH'
  return null
}

export function resolveSaleUnits(lines: ReadonlyArray<UnitLine>, partIdsOf: (modelId: string) => ReadonlyArray<string>): SaleUnitPlan {
  const allPartsOf = (modelId: string) => Array.from(new Set(partIdsOf(modelId)))
  const isMultipart = (modelId: string) => allPartsOf(modelId).length > 1
  const notices: UnitNotice[] = []

  // A key means something only on a part of a model made of several parts.
  const candidates: number[] = []
  const strayKeys: number[] = []
  lines.forEach((line, position) => {
    if (!line.setKey) return
    if (line.partId && !line.productTemplateId && isMultipart(line.modelId)) candidates.push(position)
    else strayKeys.push(position)
  })
  if (strayKeys.length > 0) notices.push({ code: 'SET_NOT_VALID', reason: 'KEY_ON_NON_PART', itemIndexes: strayKeys.map((position) => lines[position].index) })

  // Which candidate lines are believed to be a complete copy: position -> the group they belong to (null = not believed).
  const byKey = new Map<string, number[]>()
  for (const position of candidates) byKey.set(lines[position].setKey as string, [...(byKey.get(lines[position].setKey as string) ?? []), position])
  const accepted = new Map<number, number[]>() // first position of the group -> its positions
  const inSet = new Set<number>()
  for (const positions of byKey.values()) {
    const group = positions.map((position) => lines[position])
    const models = new Set(group.map((line) => line.modelId))
    const reason: SetRejection | null = models.size > 1 ? 'KEY_ACROSS_MODELS' : rejectionOf(group, allPartsOf(group[0].modelId))
    if (reason) {
      notices.push({ code: 'SET_NOT_VALID', reason, itemIndexes: group.map((line) => line.index) })
      continue
    }
    accepted.set(positions[0], positions)
    positions.forEach((position) => inSet.add(position))
  }

  // The units, in the order of the lines.
  const units: SaleUnit[] = []
  const unitOfLine: number[] = new Array(lines.length).fill(-1)
  let ordinal = 0
  lines.forEach((line, position) => {
    if (unitOfLine[position] !== -1) return
    const group = accepted.get(position)
    if (group) {
      ordinal += 1
      const unitIndex = units.length
      units.push({ kind: 'set', lineIndexes: group, copies: lines[group[0]].qty, setOrdinal: ordinal, partCount: group.length })
      group.forEach((member) => { unitOfLine[member] = unitIndex })
      return
    }
    if (inSet.has(position)) return // a later line of a set that started earlier: already placed
    const kind: UnitKind = line.productTemplateId ? 'product' : !line.partId ? 'whole' : 'part'
    unitOfLine[position] = units.length
    units.push({ kind, lineIndexes: [position], copies: line.qty, setOrdinal: null, partCount: 1 })
  })

  // A suggestion, never an assumption: loose parts (no key at all) of a model that together hold a copy of EVERY part.
  const looseByModel = new Map<string, number[]>()
  lines.forEach((line, position) => {
    if (line.setKey || !line.partId || line.productTemplateId || !isMultipart(line.modelId)) return
    looseByModel.set(line.modelId, [...(looseByModel.get(line.modelId) ?? []), position])
  })
  for (const [modelId, positions] of looseByModel) {
    const copies = new Map<string, number>()
    for (const position of positions) copies.set(lines[position].partId as string, (copies.get(lines[position].partId as string) ?? 0) + lines[position].qty)
    const all = allPartsOf(modelId)
    if (all.length > 0 && all.every((part) => (copies.get(part) ?? 0) > 0)) {
      notices.push({ code: 'COULD_BE_COMPLETE_MODEL', itemIndexes: positions.map((position) => lines[position].index), copies: Math.min(...all.map((part) => copies.get(part) ?? 0)) })
    }
  }

  return { units, unitOfLine, notices }
}
