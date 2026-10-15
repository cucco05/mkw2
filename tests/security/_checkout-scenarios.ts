// Carts used to check that the same amount travels unchanged from the cart to the quote, the order and Stripe (checkout-consistency.sec.ts)
// and to compare it with what the cart page shows (the browser run described in docs/VERIFICA-CARRELLO-PREVENTIVO-STRIPE.md).
// Import AFTER ./_harness (it needs the test database). Fake data only.
import { db, seedShopModel } from './_harness'
import { TOLERANCE_PRICE_MULTIPLIER } from '../../lib/price-multiplier'

export type ModelKey = 'V' | 'L' | 'P' | 'F' | 'S' | 'D' | 'T'
export type ItemSpec = {
  model: ModelKey
  // 1 or 2 for the two parts of model P
  part?: 1 | 2
  qty?: number
  material?: string
  colors?: string[]
  finish?: string | null
  infillPct?: number | null
  scale?: number
  dimensionOverrides?: { x?: number; y?: number; z?: number } | null
  toleranceClass?: 'draft' | 'standard' | 'cosmetic' | 'fit_critical'
  // a ready-made product (model T): colour of the variant picked
  variantColor?: string
}
export type Scenario = {
  id: string
  label: string
  items: ItemSpec[]
  shipping: 'pickup' | 'ship'
  rush?: boolean
  // "discount": a registered customer with a 10% + 5% (friends and family) discount
  who?: 'guest' | 'discount'
  tax: { mode?: 'inclusive' | 'exclusive'; rate?: string }
  shippingCents?: string
}

const W = ['#ffffff']
export const SCENARIOS: Scenario[] = [
  { id: '01', label: 'Vaso x1 PLA, ritiro, senza IVA', items: [{ model: 'V', qty: 1 }], shipping: 'pickup', tax: {} },
  { id: '02', label: 'Vaso x3 PLA, ritiro, IVA inclusa 22%', items: [{ model: 'V', qty: 3 }], shipping: 'pickup', tax: { mode: 'inclusive', rate: '22' } },
  { id: '03', label: 'Vaso x2 PETG opaco, spedizione, IVA inclusa 22%', items: [{ model: 'V', qty: 2, material: 'PETG', finish: 'matte' }], shipping: 'ship', tax: { mode: 'inclusive', rate: '22' } },
  { id: '04', label: 'Lampada ABS lucida + Vaso riempimento 35%, spedizione, IVA esclusa 22%', items: [{ model: 'L', material: 'ABS', finish: 'gloss' }, { model: 'V', infillPct: 35 }], shipping: 'ship', tax: { mode: 'exclusive', rate: '22' } },
  { id: '05', label: 'Vaso scala 1,5 x2, 2 colori, ritiro, IVA esclusa 22%', items: [{ model: 'V', qty: 2, scale: 1.5, colors: ['#ffffff', '#000000'] }], shipping: 'pickup', tax: { mode: 'exclusive', rate: '22' } },
  { id: '06', label: 'Vaso scala 0,5 (sotto il prezzo minimo), ritiro, IVA inclusa 22%', items: [{ model: 'V', scale: 0.5 }], shipping: 'pickup', tax: { mode: 'inclusive', rate: '22' } },
  { id: '07', label: 'Vaso con scale diverse per asse 2 x 1 x 0,5, ritiro', items: [{ model: 'V', dimensionOverrides: { x: 2, y: 1, z: 0.5 } }], shipping: 'pickup', tax: {} },
  { id: '08', label: 'Vaso tolleranza cosmetica, urgente, spedizione, IVA inclusa 22%', items: [{ model: 'V', toleranceClass: 'cosmetic' }], shipping: 'ship', rush: true, tax: { mode: 'inclusive', rate: '22' } },
  { id: '09', label: 'Modello a due parti: parte 1 x2 + parte 2 x1, spedizione, IVA esclusa 22%', items: [{ model: 'P', part: 1, qty: 2 }, { model: 'P', part: 2, qty: 1 }], shipping: 'ship', tax: { mode: 'exclusive', rate: '22' } },
  { id: '10', label: 'Modello a prezzo fisso, 3 colori x4, ritiro', items: [{ model: 'F', qty: 4, colors: ['#ffffff', '#000000', '#ff0000'] }], shipping: 'pickup', tax: {} },
  { id: '11', label: 'Modello in saldo PLA + PETG, spedizione, IVA inclusa 22%', items: [{ model: 'S' }, { model: 'S', material: 'PETG' }], shipping: 'ship', tax: { mode: 'inclusive', rate: '22' } },
  { id: '12', label: 'Cliente con sconto 10% + 5%: Vaso x3 + Lampada x2, spedizione, IVA esclusa 22%', items: [{ model: 'V', qty: 3 }, { model: 'L', qty: 2 }], shipping: 'ship', who: 'discount', tax: { mode: 'exclusive', rate: '22' } },
  { id: '13', label: 'Cliente con sconto: modello che esclude gli sconti + Vaso, ritiro, IVA inclusa 22%', items: [{ model: 'D' }, { model: 'V' }], shipping: 'pickup', who: 'discount', tax: { mode: 'inclusive', rate: '22' } },
  { id: '14', label: 'Sconto quantità: Vaso x12 (5%) + Lampada x30 (10%), ritiro, IVA esclusa 10%', items: [{ model: 'V', qty: 12 }, { model: 'L', qty: 30 }], shipping: 'pickup', tax: { mode: 'exclusive', rate: '10' } },
  { id: '15', label: 'Arrotondamenti: Vaso x7 + Lampada x3 + Parte 1 x5, cliente scontato, spedizione, IVA esclusa 22%', items: [{ model: 'V', qty: 7 }, { model: 'L', qty: 3 }, { model: 'P', part: 1, qty: 5 }], shipping: 'ship', who: 'discount', tax: { mode: 'exclusive', rate: '22' } },
  { id: '16', label: 'Prodotto con variante (1,5 x 2,0, PETG opaco) x2, spedizione, IVA esclusa 4%', items: [{ model: 'T', qty: 2, variantColor: '#ffd700' }], shipping: 'ship', tax: { mode: 'exclusive', rate: '4' } },
  { id: '17', label: 'Spedizione gratuita deliberata (0 centesimi), Vaso x2, IVA inclusa 22%', items: [{ model: 'V', qty: 2 }], shipping: 'ship', tax: { mode: 'inclusive', rate: '22' }, shippingCents: '0' },
  { id: '18', label: 'Vaso x50 (massimo per riga), urgente, ritiro, IVA esclusa 22%', items: [{ model: 'V', qty: 50 }], shipping: 'pickup', rush: true, tax: { mode: 'exclusive', rate: '22' } },
]

export type ScenarioData = {
  ids: Record<ModelKey, string>
  partIds: [string, string]
  productId: string
  discountUser: { id: string }
  // the model data exactly as the model page hands it to the cart
  detail: Record<ModelKey, { title: string; priceUsd: number | null; sizeXmm: number | null; sizeYmm: number | null; sizeZmm: number | null; flatRatePricing: boolean }>
  parts: Array<{ id: string; name: string; index: number; priceUsd: number | null; sizeXmm: number | null; sizeYmm: number | null; sizeZmm: number | null }>
}

// Shop-wide settings used by every scenario (as an administrator would have set them).
export async function seedScenarioConfig() {
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({
    data: {
      id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, energyUsdPerHour: 0.15, minimumPriceUsd: 5, targetMarginPercent: 20,
      batchDiscountTiers: [{ minQty: 10, percent: 5 }, { minQty: 25, percent: 10 }],
    } as any,
  })
}

export async function seedScenarioModels(tag = 'cons'): Promise<ScenarioData> {
  const prisma = await db()
  const { updateModelPricingForModel } = await import('../../lib/model-pricing')
  const { loadModelDetail } = await import('../../lib/model-detail')
  const shop = await seedShopModel({ volumeMm3: 400000 })
  const owner = shop.user.id
  const mk = (title: string, over: Record<string, unknown>) => prisma.model.create({
    data: {
      title: `${tag} ${title}`, filePath: `models/${owner}/${tag}-${title}.stl`, fileType: 'stl', userId: owner, visibility: 'public', material: 'PLA',
      volumeMm3: 150000, priceUsd: 1, effectivePriceUsd: 1, sizeXmm: 51.37, sizeYmm: 49.82, sizeZmm: 119.64, colorSlotCount: 4, ...over,
    } as any,
  })
  // real parts are never round numbers: the size matters for how a chosen scale turns into millimetres and back
  const V = await prisma.model.update({ where: { id: shop.model.id }, data: { title: `${tag} Vaso`, colorSlotCount: 4, material: 'PLA', sizeXmm: 83.47, sizeYmm: 61.13, sizeZmm: 47.92 } as any })
  const L = await mk('Lampada', {})
  const P = await mk('Modello a due parti', { volumeMm3: 150000 })
  const part = (index: number, name: string, vol: number) => prisma.modelPart.create({
    data: { modelId: P.id, index, name, filePath: `models/${owner}/${tag}-p${index}.stl`, volumeMm3: vol, sizeXmm: 40, sizeYmm: 40, sizeZmm: 60 } as any,
  })
  const p1 = await part(0, 'Corpo', 100000)
  const p2 = await part(1, 'Coperchio', 50000)
  const F = await mk('Prezzo fisso', { flatRatePricing: true, volumeMm3: 80000 })
  const S = await mk('In saldo', { salePriceUsd: 6.5 })
  const D = await mk('Senza sconti cliente', { disableCustomerDiscounts: true, volumeMm3: 90000 })
  const productBase = await mk('Base del prodotto', { volumeMm3: 150000 })
  const product = await prisma.productTemplate.create({
    data: {
      title: `${tag} Prodotto con varianti`, baseModelId: productBase.id, isActive: true, lockedMaterial: 'PETG', lockedFinish: 'matte', lockedScale: 1, lockedPriceMultiplier: 1.5,
      colorOptions: [{ label: 'Bianco', value: '#ffffff', colorCount: 1, priceMultiplier: 1 }, { label: 'Oro', value: '#ffd700', colorCount: 1, priceMultiplier: 2 }],
    } as any,
  })
  // A single-part model has ONE part row (what an upload creates); the stored prices are then refreshed the way the shop does it, so that
  // the price the model page shows, and the cart multiplies, is the real one and not a number typed into the seed.
  for (const model of [V, L, F, S, D, productBase]) {
    await prisma.modelPart.create({
      data: { modelId: model.id, index: 0, name: 'Part 1', filePath: model.filePath, volumeMm3: model.volumeMm3, sizeXmm: model.sizeXmm, sizeYmm: model.sizeYmm, sizeZmm: model.sizeZmm } as any,
    })
    await updateModelPricingForModel(model.id)
  }
  await updateModelPricingForModel(P.id)
  const discountUser = await prisma.user.create({
    data: { email: `${tag}-discount@sectest.invalid`, passwordHash: 'x', name: 'Cliente scontato', role: 'customer', discountPercent: 10, isFriendsAndFamily: true, friendsAndFamilyPercent: 5 } as any,
  })
  const ids = { V: V.id, L: L.id, P: P.id, F: F.id, S: S.id, D: D.id, T: productBase.id } as Record<ModelKey, string>
  const detail = {} as ScenarioData['detail']
  let parts: ScenarioData['parts'] = []
  for (const key of Object.keys(ids) as ModelKey[]) {
    const loaded = await loadModelDetail(ids[key], null)
    const model = loaded!.model
    detail[key] = { title: model.title, priceUsd: model.priceUsd ?? null, sizeXmm: model.sizeXmm ?? null, sizeYmm: model.sizeYmm ?? null, sizeZmm: model.sizeZmm ?? null, flatRatePricing: Boolean(model.flatRatePricing) }
    if (key === 'P') parts = (model.parts as any[]).map((entry, i) => ({ id: entry.id, name: entry.name, index: entry.index ?? i, priceUsd: entry.priceUsd ?? null, sizeXmm: entry.sizeXmm ?? null, sizeYmm: entry.sizeYmm ?? null, sizeZmm: entry.sizeZmm ?? null }))
  }
  return { ids, partIds: [p1.id, p2.id], productId: product.id, discountUser: { id: discountUser.id }, detail, parts }
}

// The line of the cart exactly as the cart stores it when the page adds it (components/InstantQuoteConfigurator.tsx and ProductConfigurator.tsx).
export function persistedCartItem(spec: ItemSpec, data: ScenarioData, index: number) {
  const base = data.detail[spec.model]
  const part = spec.part ? data.parts[spec.part - 1] : null
  const tolerance = spec.toleranceClass ?? 'standard'
  const isProduct = spec.model === 'T'
  return {
    cartItemId: `scn-${index}`,
    modelId: data.ids[spec.model],
    partId: part ? part.id : null,
    partName: part ? part.name : null,
    partIndex: part ? part.index : null,
    flatRatePricing: base.flatRatePricing,
    title: isProduct ? 'Prodotto con varianti' : base.title,
    priceUsd: part ? part.priceUsd : base.priceUsd,
    thumbnail: null,
    size: part ? { x: part.sizeXmm ?? undefined, y: part.sizeYmm ?? undefined, z: part.sizeZmm ?? undefined } : { x: base.sizeXmm ?? undefined, y: base.sizeYmm ?? undefined, z: base.sizeZmm ?? undefined },
    colorSlotCount: 4,
    allowedColors: null,
    options: isProduct
      ? { qty: spec.qty ?? 1, scale: 1, material: 'PETG', colors: [spec.variantColor ?? '#ffffff'], finish: 'matte', lockedConfig: true, productTemplateId: data.productId, priceMultiplier: Number((1.5 * (spec.variantColor === '#ffd700' ? 2 : 1)).toFixed(4)), lockDimensions: true, dimensionOverrides: null, infillPct: null, customText: null, toleranceClass: null }
      : {
        qty: spec.qty ?? 1, scale: spec.scale ?? 1, material: spec.material ?? 'PLA', colors: spec.colors ?? W, finish: spec.finish ?? null, infillPct: spec.infillPct ?? null,
        toleranceClass: tolerance, priceMultiplier: TOLERANCE_PRICE_MULTIPLIER[tolerance], dimensionOverrides: spec.dimensionOverrides ?? null,
        lockDimensions: !spec.dimensionOverrides, lockedConfig: false, productTemplateId: null, customText: null,
      },
  }
}
