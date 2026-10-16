// Step 4.4 – the first machine offers PLA and PETG; TPU (and every other material) only after the shop owner confirms it.
//
// The data migration 20261019120000_a1_mini_materials_pla_petg takes TPU out of the A1 mini's material list - and nothing else:
//   * only while the list is still EXACTLY what the first migration inserted (PLA, PETG, TPU): an administrator's own list is never overwritten, however
//     small the difference (an added material, a different order, a removed one);
//   * it can be applied again without changing anything, and it never touches the volume (180 x 180 x 180 mm), the margins, the nozzle, the finishes or
//     another machine;
//   * the support for other materials is not removed from the code: an administrator adds TPU back from Admin -> Printer machines, and it is sold again.
// Then, with the machine the way a fresh installation has it, a TPU line goes to manual review and PLA/PETG lines are priced and paid online.
import { configureTestMachine, db, resetDb, seedShopModel } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'

const SQL = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261019120000_a1_mini_materials_pla_petg/migration.sql'), 'utf8')
const FIRST_MIGRATION = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261018120000_printer_machines/migration.sql'), 'utf8')
const SEED_MATERIALS = ['PLA', 'PETG', 'TPU']
let modelId = ''

const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
let ip = 0

const applyMigration = async () => (await db()).$executeRawUnsafe(SQL)
const machine = async () => (await db()).printerMachine.findUniqueOrThrow({ where: { key: 'bambu-a1-mini' } })
async function quote(material: string) {
  viewerGuards.getViewer = async () => null
  const mod = await import('../../app/api/checkout/quote/route')
  const res = (await (mod.POST as any)(new NextRequest('http://localhost/api/checkout/quote', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': `10.12.0.${++ip % 250}` },
    body: JSON.stringify({ items: [{ modelId, qty: 1, colors: ['#ffffff'], material }], shipping: { method: 'pickup' }, rush: false }),
  }), {})) as Response
  return { status: res.status, json: await res.json() }
}

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  await installFakeCheckout()
})
test.after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
  await resetDb()
})

test('the first migration still inserts PLA, PETG and TPU (the starting point the data migration is written for)', () => {
  assert.match(FIRST_MIGRATION, /ARRAY\['PLA', 'PETG', 'TPU'\]/)
})

test('the machine as the first migration made it: TPU is taken out, PLA and PETG stay, the volume and everything else are untouched', async () => {
  await configureTestMachine({ allowedMaterials: [...SEED_MATERIALS], notes: 'initial', marginXYmm: 3, marginZmm: 2, supportMarginXYmm: 3 })
  const before = await machine()
  await applyMigration()
  const after = await machine()
  assert.deepEqual(after.allowedMaterials, ['PLA', 'PETG'])
  for (const field of ['buildXmm', 'buildYmm', 'buildZmm', 'marginXYmm', 'marginZmm', 'supportMarginXYmm', 'nozzleDiameterMm', 'minFeatureMm', 'maxSupportRatio', 'allowedFinishes', 'notes', 'label', 'isActive', 'id'] as const) {
    assert.deepEqual(after[field], before[field], field)
  }
  assert.deepEqual([after.buildXmm, after.buildYmm, after.buildZmm], [180, 180, 180], 'the nominal volume of the A1 mini')
  assert.equal(after.nozzleDiameterMm, 0.4)
})

test('applying it again changes nothing (not even the time of the last edit)', async () => {
  await configureTestMachine({ allowedMaterials: [...SEED_MATERIALS] })
  await applyMigration()
  const once = await machine()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await applyMigration()
  const twice = await machine()
  assert.deepEqual(twice.allowedMaterials, ['PLA', 'PETG'])
  assert.equal(twice.updatedAt.getTime(), once.updatedAt.getTime())
})

test('an administrator\'s own list is never overwritten, however small the difference', async () => {
  const customised: string[][] = [
    ['PLA', 'PETG', 'TPU', 'ABS'],   // added a material
    ['PLA', 'PETG'],                  // already the target
    ['PLA', 'TPU'],                   // removed PETG, kept TPU on purpose
    ['TPU', 'PLA', 'PETG'],           // same materials, another order
    ['PLA', 'PETG', 'TPU', 'ASA', 'PC'],
    ['pla', 'petg', 'tpu'],           // written differently
    [],
  ]
  for (const materials of customised) {
    await configureTestMachine({ allowedMaterials: materials })
    const before = await machine()
    await applyMigration()
    const after = await machine()
    assert.deepEqual(after.allowedMaterials, materials, JSON.stringify(materials))
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), `${JSON.stringify(materials)}: not even touched`)
  }
})

test('another machine is never touched, even with the same material list', async () => {
  await configureTestMachine({ allowedMaterials: [...SEED_MATERIALS] }, [{ key: 'second-machine', label: 'Second machine', allowedMaterials: [...SEED_MATERIALS] }])
  await applyMigration()
  const second = await (await db()).printerMachine.findUniqueOrThrow({ where: { key: 'second-machine' } })
  assert.deepEqual(second.allowedMaterials, SEED_MATERIALS)
})

test('with the starting configuration of a fresh installation: PLA and PETG are priced and offered, TPU goes to a person', async () => {
  await configureTestMachine({ allowedMaterials: [...SEED_MATERIALS] })
  await applyMigration()
  for (const material of ['PLA', 'PETG', 'petg']) {
    const ok = await quote(material)
    assert.equal(ok.status, 200, `${material}: ${JSON.stringify(ok.json)}`)
    assert.equal(ok.json.canCheckout, true)
  }
  const tpu = await quote('TPU')
  assert.equal(tpu.status, 422, JSON.stringify(tpu.json))
  assert.equal(tpu.json.code, 'MANUAL_REVIEW_REQUIRED')
  assert.equal(tpu.json.details.reviews[0].reasons[0].code, 'MATERIAL_NOT_AVAILABLE')
})

test('the support for other materials is still there: when the owner confirms TPU and adds it, it is sold again (nothing was removed from the code)', async () => {
  await configureTestMachine({ allowedMaterials: ['PLA', 'PETG'] })
  assert.equal((await quote('TPU')).status, 422)
  await configureTestMachine({ allowedMaterials: ['PLA', 'PETG', 'TPU'] }) // what Admin -> Printer machines does
  const tpu = await quote('TPU')
  assert.equal(tpu.status, 200, JSON.stringify(tpu.json))
  await configureTestMachine({ allowedMaterials: ['PLA', 'PETG', 'ABS'] })
  assert.equal((await quote('ABS')).status, 200)
})
