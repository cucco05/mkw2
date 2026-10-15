// Step 4.2-ter (A4/A8): the machines are DATA that an administrator edits - who may, what is accepted, and that a change really changes what can be
// paid online (no code involved). Fake Stripe, throw-away database, fake data.
import { configureTestMachine, db, resetDb } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { persistedCartItem, seedScenarioConfig, seedScenarioModels, type ItemSpec, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'

let data: ScenarioData
let adminId = ''
let ipSeq = 0
const nextIp = () => `10.31.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]

type Viewer = { id: string; role: string } | null
async function admin(method: 'GET' | 'POST' | 'PATCH', viewer: Viewer, body?: unknown, id?: string) {
  viewerGuards.getViewer = async () => viewer as any
  const url = `http://localhost/api/admin/printer-machines${id ? `/${id}` : ''}`
  const req = new NextRequest(url, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const res = (id
    ? await ((await import('../../app/api/admin/printer-machines/[id]/route')) as any)[method](req, { params: Promise.resolve({ id }) })
    : await ((await import('../../app/api/admin/printer-machines/route')) as any)[method](req, {})) as Response
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}
async function quote(material: string) {
  viewerGuards.getViewer = async () => null
  const request: any = buildQuoteRequest([persistedCartItem({ model: 'V' } as ItemSpec, data, 0)] as any, { shippingMethod: 'pickup', rush: false })
  request.items[0].material = material
  const mod = await import('../../app/api/checkout/quote/route')
  const res = (await (mod.POST as any)(new NextRequest('http://localhost/api/checkout/quote', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(request) }), {})) as Response
  return { status: res.status, json: await res.json() }
}
const valid = (over: Record<string, unknown> = {}) => ({
  key: 'second-machine', label: 'Second machine', isActive: true, buildXmm: 256, buildYmm: 256, buildZmm: 256, marginXYmm: 3, marginZmm: 2, supportMarginXYmm: 3,
  nozzleDiameterMm: 0.4, allowedMaterials: ['PLA', 'PETG', 'ABS'], allowedFinishes: ['standard', 'matte'], ...over,
})

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  await seedScenarioConfig()
  data = await seedScenarioModels('pm')
  await installFakeCheckout()
  const prisma = await db()
  adminId = (await prisma.user.create({ data: { email: 'pm-admin@sectest.invalid', passwordHash: 'x', name: 'Admin', role: 'admin', isAdmin: true } as any })).id
})
test.beforeEach(async () => { await configureTestMachine({ allowedMaterials: ['PLA', 'PETG', 'TPU'] }) })
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

test('only an administrator can see or change the machines (not a visitor, a customer or staff)', async () => {
  for (const [who, viewer, status] of [['visitor', null, 401], ['customer', { id: 'c1', role: 'customer' }, 403], ['staff', { id: 's1', role: 'staff' }, 403]] as const) {
    for (const method of ['GET', 'POST'] as const) {
      const r = await admin(method, viewer, method === 'POST' ? valid() : undefined)
      assert.equal(r.status, status, `${who} ${method}`)
    }
    const patch = await admin('PATCH', viewer, { isActive: false }, 'whatever')
    assert.equal(patch.status, status, `${who} PATCH`)
  }
  const prisma = await db()
  assert.equal(await prisma.printerMachine.count(), 1, 'nothing was created')
})

test('an administrator lists the machines with the options that can be ticked', async () => {
  const r = await admin('GET', { id: adminId, role: 'admin' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.machines.length, 1)
  assert.equal(r.json.machines[0].key, 'bambu-a1-mini')
  assert.ok(r.json.options.materials.includes('PLA'))
  assert.ok(r.json.options.finishes.includes('matte'))
})

test('a machine is added with data only - and what it offers changes what can be paid online at once', async () => {
  const before = await quote('ASA')
  assert.equal(before.status, 422)
  assert.equal(before.json.details.reviews[0].reasons[0].code, 'MATERIAL_NOT_AVAILABLE')
  const created = await admin('POST', { id: adminId, role: 'admin' }, valid({ allowedMaterials: ['PLA', 'ASA'] }))
  assert.equal(created.status, 201, created.text)
  assert.equal((await quote('ASA')).status, 200, 'the new machine offers ASA')
  const off = await admin('PATCH', { id: adminId, role: 'admin' }, { isActive: false }, created.json.machine.id)
  assert.equal(off.status, 200, off.text)
  assert.equal((await quote('ASA')).status, 422, 'switched off: ASA is not offered again')
})

test('a change is a partial update checked as a whole, and it is recorded in the audit log', async () => {
  const prisma = await db()
  const a1 = await prisma.printerMachine.findUniqueOrThrow({ where: { key: 'bambu-a1-mini' } })
  const auditedBefore = await prisma.adminAuditEvent.count({ where: { action: 'printer_machine.update', targetId: a1.id } })
  const ok = await admin('PATCH', { id: adminId, role: 'admin' }, { allowedMaterials: ['PLA', 'PETG', 'TPU', 'ABS'], marginXYmm: 4 }, a1.id)
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(ok.json.machine.allowedMaterials, ['PLA', 'PETG', 'TPU', 'ABS'])
  assert.equal(ok.json.machine.buildXmm, 180, 'what was not sent is kept')
  assert.equal(ok.json.machine.marginXYmm, 4)
  const events = await prisma.adminAuditEvent.findMany({ where: { action: 'printer_machine.update', targetId: a1.id }, orderBy: { createdAt: 'desc' } })
  assert.equal(events.length, auditedBefore + 1)
  assert.equal(events[0].adminId, adminId)
  const missing = await admin('PATCH', { id: adminId, role: 'admin' }, { isActive: false }, 'does-not-exist')
  assert.equal(missing.status, 404)
})

test('nonsense is refused: sizes, margins, unknown materials or finishes, odd keys, extra fields', async () => {
  const prisma = await db()
  const a1 = await prisma.printerMachine.findUniqueOrThrow({ where: { key: 'bambu-a1-mini' } })
  const bad: Array<Record<string, unknown>> = [
    { buildXmm: 0 }, { buildYmm: -5 }, { buildZmm: 100000 }, { buildXmm: 'wide' }, { nozzleDiameterMm: 0 }, { nozzleDiameterMm: 5 },
    { marginXYmm: 90 }, { marginZmm: 180 }, { marginXYmm: -1 }, { maxSupportRatio: 2 }, { minFeatureMm: -1 },
    { allowedMaterials: ['PLA', 'UNOBTAINIUM'] }, { allowedFinishes: ['gold-plated'] }, { allowedMaterials: 'PLA' },
    { key: 'Has Spaces' }, { key: '' }, { label: '' }, { isActive: 'yes' }, { totalCents: 1 }, { id: 'other' },
  ]
  for (const patch of bad) {
    const r = await admin('PATCH', { id: adminId, role: 'admin' }, patch, a1.id)
    assert.equal(r.status, 400, `${JSON.stringify(patch)} -> ${r.status} ${r.text}`)
  }
  const unchanged = await prisma.printerMachine.findUniqueOrThrow({ where: { id: a1.id } })
  assert.equal(unchanged.buildXmm, 180)
  assert.equal(unchanged.marginXYmm, 3)
  assert.deepEqual(unchanged.allowedMaterials, ['PLA', 'PETG', 'TPU'])
  const dup = await admin('POST', { id: adminId, role: 'admin' }, valid({ key: 'bambu-a1-mini' }))
  assert.equal(dup.status, 409)
  assert.equal((await admin('POST', { id: adminId, role: 'admin' }, valid({ allowedMaterials: ['NOPE'] }))).status, 400)
  assert.equal((await admin('POST', { id: adminId, role: 'admin' }, { ...valid(), extra: true })).status, 400)
})
