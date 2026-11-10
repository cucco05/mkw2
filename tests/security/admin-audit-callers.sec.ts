// The routes that write an audit event WITHOUT handing over a transaction (lib/admin-audit.ts, recordAdminAuditEvent(input)): thirteen call sites, nine of which no other test of the security
// suite reaches. Since the helper was made safe for a caller that hands over nothing (it now opens its own short transaction, so that the chain lock holds across its statements), each of these
// routes is called here FOR REAL - the route handler, as an administrator, against the test database - and must still do what it did: answer as it answered, and leave its event, with its action,
// its target and its request, in a log that is still one chain.
// (The other four - external-effects/proof_refused, stripe-attach/refused and the two printer-machines routes - have tests of their own; the eighteen call sites that hand over their
// transaction are reached by the order, payment-hold, waiver, receipt, printlab and job suites.)
// The operation these routes do is NOT atomic with its event (the event is written after it, by a transaction of its own): that is the state of affairs before and after the fix, said here so
// that nobody reads these tests as a promise of it.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { db, resetDb, seedShopModel } from './_harness'
import { viewerGuards } from '../../lib/viewer'
import * as audit from '../../lib/admin-audit'

let prisma: Awaited<ReturnType<typeof db>>
let admin: { id: string }
let ip = 0

test.before(async () => {
  await resetDb()
  prisma = await db()
  await prisma.adminAuditEvent.deleteMany()
  admin = await prisma.user.create({ data: { email: 'callers-admin@sectest.invalid', passwordHash: 'x', name: 'Callers Admin', role: 'admin', isAdmin: true } })
  viewerGuards.getViewer = async () => ({ id: admin.id, role: 'admin' }) as any
})
test.beforeEach(async () => { await prisma.adminAuditEvent.deleteMany(); viewerGuards.getViewer = async () => ({ id: admin.id, role: 'admin' }) as any })
test.after(async () => { await prisma.adminAuditEvent.deleteMany(); await resetDb() })

async function call(modulePath: string, method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, params?: Record<string, string>) {
  const mod: any = await import(modulePath)
  const req = new NextRequest(`http://localhost${url}`, {
    method, headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': `10.78.0.${++ip}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const res: Response = await mod[method](req, params ? { params: Promise.resolve(params) } : {})
  return { status: res.status, text: await res.text() }
}
// the event the route left: one, with its action, written for the administrator who did it, with the request it came from
async function theEvent(action: string, over: { targetType?: string; targetId?: string | null; method: string; pathStartsWith: string }) {
  const events = await prisma.adminAuditEvent.findMany({ where: { action } })
  assert.equal(events.length, 1, `exactly one "${action}" event`)
  const [event] = events
  assert.equal(event.adminId, admin.id)
  assert.equal(event.requestMethod, over.method)
  assert.ok(event.requestPath.startsWith(over.pathStartsWith), `request path ${event.requestPath}`)
  if (over.targetType !== undefined) assert.equal(event.targetType, over.targetType)
  if (over.targetId !== undefined) assert.equal(event.targetId, over.targetId)
  assert.match(event.eventHash, /^[0-9a-f]{64}$/)
  assert.equal(event.prevHash, null, 'the first and only event of this log')
  return event
}

test('data-retention POST (dry run): 200, and its event with the summary', async () => {
  const r = await call('../../app/api/admin/data-retention/route', 'POST', '/api/admin/data-retention', { dryRun: true })
  assert.equal(r.status, 200, r.text)
  const event = await theEvent('admin.data_retention.run', { targetType: 'system', method: 'POST', pathStartsWith: '/api/admin/data-retention' })
  assert.equal((event.metadata as any)?.dryRun, true)
})

test('featured POST: 200, and its event', async () => {
  const model = (await seedShopModel()).model
  const r = await call('../../app/api/admin/featured/route', 'POST', '/api/admin/featured', { modelIds: [model.id] })
  assert.equal(r.status, 200, r.text)
  await theEvent('admin.featured.update', { method: 'POST', pathStartsWith: '/api/admin/featured' })
})

test('models/[id] PATCH: 200, and its event', async () => {
  const model = (await seedShopModel()).model
  const r = await call('../../app/api/admin/models/[id]/route', 'PATCH', `/api/admin/models/${model.id}`, { title: 'Renamed by the audit test', tags: ['audit', 'chain'] }, { id: model.id })
  assert.equal(r.status, 200, r.text)
  await theEvent('admin.model.update', { targetId: model.id, method: 'PATCH', pathStartsWith: '/api/admin/models/' })
})

test('models/[id] DELETE: 200, the model is gone, and its event', async () => {
  const model = (await seedShopModel()).model
  const r = await call('../../app/api/admin/models/[id]/route', 'DELETE', `/api/admin/models/${model.id}`, undefined, { id: model.id })
  assert.equal(r.status, 200, r.text)
  assert.equal(await prisma.model.count({ where: { id: model.id } }), 0)
  await theEvent('admin.model.delete', { targetId: model.id, method: 'DELETE', pathStartsWith: '/api/admin/models/' })
})

test('products/[id] PATCH: 200, and its event', async () => {
  const product = await prisma.productTemplate.create({ data: { title: 'Audit test product' } })
  const r = await call('../../app/api/admin/products/[id]/route', 'PATCH', `/api/admin/products/${product.id}`, { title: 'Audit test product, renamed' }, { id: product.id })
  assert.equal(r.status, 200, r.text)
  await theEvent('admin.product_template.update', { targetId: product.id, method: 'PATCH', pathStartsWith: '/api/admin/products/' })
})

test('products/[id] DELETE: 200, the product is gone, and its event', async () => {
  const product = await prisma.productTemplate.create({ data: { title: 'Audit test product to delete' } })
  const r = await call('../../app/api/admin/products/[id]/route', 'DELETE', `/api/admin/products/${product.id}`, undefined, { id: product.id })
  assert.equal(r.status, 200, r.text)
  assert.equal(await prisma.productTemplate.count({ where: { id: product.id } }), 0)
  await theEvent('admin.product_template.delete', { targetId: product.id, method: 'DELETE', pathStartsWith: '/api/admin/products/' })
})

test('site-config PATCH (a value that does not change anything): the change is saved and its event is written - the route answers what it answered before (outside the web server, the page revalidation that follows is refused: that is the same with the helper as it was)', async () => {
  const before = await prisma.siteConfig.findUnique({ where: { id: 'main' } })
  try {
    const r = await call('../../app/api/admin/site-config/route', 'PATCH', '/api/admin/site-config', { minimumPriceUsd: before?.minimumPriceUsd ?? 5 })
    assert.ok(r.status === 200 || (r.status === 400 && /static generation store missing in revalidatePath/.test(r.text)), `${r.status} ${r.text.slice(0, 200)}`)
    await theEvent('admin.site_config.update', { method: 'PATCH', pathStartsWith: '/api/admin/site-config' })
  } finally {
    if (!before) await prisma.siteConfig.deleteMany({ where: { id: 'main' } })      // the test leaves the configuration as it found it
  }
})

test('users/[id] PATCH: 200, and its event with the keys that were updated', async () => {
  const target = await prisma.user.create({ data: { email: 'callers-target@sectest.invalid', passwordHash: 'x', name: 'Target', role: 'customer' } })
  const r = await call('../../app/api/admin/users/[id]/route', 'PATCH', `/api/admin/users/${target.id}`, { name: 'Target, renamed' }, { id: target.id })
  assert.equal(r.status, 200, r.text)
  const event = await theEvent('admin.user.update', { targetId: target.id, method: 'PATCH', pathStartsWith: '/api/admin/users/' })
  assert.deepEqual((event.metadata as any)?.updatedUserKeys, ['name'])
})

test('users/[id] DELETE: 200, the user is gone, and its event', async () => {
  const victim = await prisma.user.create({ data: { email: 'callers-victim@sectest.invalid', passwordHash: 'x', name: 'Victim', role: 'customer' } })
  const r = await call('../../app/api/admin/users/[id]/route', 'DELETE', `/api/admin/users/${victim.id}`, undefined, { id: victim.id })
  assert.equal(r.status, 200, r.text)
  assert.equal(await prisma.user.count({ where: { id: victim.id } }), 0)
  await theEvent('admin.user.delete', { targetId: victim.id, method: 'DELETE', pathStartsWith: '/api/admin/users/' })
})

test('all nine in a row, one after the other: the log they leave is ONE chain, every hash is the hash of its own stored fields', async () => {
  await prisma.adminAuditEvent.deleteMany()
  const model = (await seedShopModel()).model
  const product = await prisma.productTemplate.create({ data: { title: 'Chain product' } })
  const target = await prisma.user.create({ data: { email: 'callers-chain@sectest.invalid', passwordHash: 'x', name: 'Chain', role: 'customer' } })
  await call('../../app/api/admin/data-retention/route', 'POST', '/api/admin/data-retention', { dryRun: true })
  await call('../../app/api/admin/featured/route', 'POST', '/api/admin/featured', { modelIds: [model.id] })
  await call('../../app/api/admin/models/[id]/route', 'PATCH', `/api/admin/models/${model.id}`, { title: 'Chain model' }, { id: model.id })
  await call('../../app/api/admin/products/[id]/route', 'PATCH', `/api/admin/products/${product.id}`, { title: 'Chain product 2' }, { id: product.id })
  await call('../../app/api/admin/users/[id]/route', 'PATCH', `/api/admin/users/${target.id}`, { name: 'Chain 2' }, { id: target.id })
  await call('../../app/api/admin/products/[id]/route', 'DELETE', `/api/admin/products/${product.id}`, undefined, { id: product.id })
  await call('../../app/api/admin/users/[id]/route', 'DELETE', `/api/admin/users/${target.id}`, undefined, { id: target.id })
  await call('../../app/api/admin/models/[id]/route', 'DELETE', `/api/admin/models/${model.id}`, undefined, { id: model.id })
  const config = await prisma.siteConfig.findUnique({ where: { id: 'main' } })
  try { await call('../../app/api/admin/site-config/route', 'PATCH', '/api/admin/site-config', { minimumPriceUsd: config?.minimumPriceUsd ?? 5 }) } finally { if (!config) await prisma.siteConfig.deleteMany({ where: { id: 'main' } }) }
  const report = await (audit as any).verifyAdminAuditChain()
  assert.equal(report.events, 9)
  assert.deepEqual({ ok: report.ok, forks: report.forks, offChain: report.offChain, hashMismatches: report.hashMismatches, dangling: report.danglingPredecessors }, { ok: true, forks: [], offChain: [], hashMismatches: [], dangling: [] })
})
