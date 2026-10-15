// S6 + S7 regression tests – customer models are private; only shop-owned models can be shown to others.
//   S6: privacy by default, nobody can publish a customer's model (administrators included), legacy "public" rows stay private.
//   S7: model APIs must not return private models, original file paths or owner e-mails to unauthorized callers,
//       and a private model must be indistinguishable from a non-existent id.
// Originally these tests reproduced the problems (todo); they now guard the fixed behaviour.
import { cartBody, db, installFakeStripe, postJson, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { canChooseUploadVisibility, resolveUploadVisibility } from '../../lib/upload-visibility'
import {
  canManageModel, canPublishModelFor, canViewModel, isModelPublished, isShopAccount,
} from '../../lib/model-access'
import { getModelLineageSummary } from '../../lib/model-lineage'

type Key = 'anon' | 'owner' | 'other' | 'staff' | 'admin'
let viewers: Record<Key, Viewer>
const ids = {} as Record<'owner' | 'other' | 'staff' | 'admin' | 'priv' | 'legacyPublic' | 'legacyUnlisted' | 'shopPub' | 'shopUnl' | 'shopPriv', string>
const EMAIL = (name: string) => `${name}@sectest.invalid`

function as(viewer: Viewer) {
  viewerGuards.getViewer = async () => viewer
}

async function getJson(url: string, handler: (req: NextRequest, ctx: any) => Promise<Response>, id: string, viewer: Viewer) {
  as(viewer)
  const res = await handler(new NextRequest(url), { params: Promise.resolve({ id }) })
  const text = await res.text()
  return { res, text }
}

async function detail(id: string, viewer: Viewer) {
  const { GET } = await import('../../app/api/models/[id]/route')
  return getJson(`http://localhost/api/models/${id}`, GET as any, id, viewer)
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  const mkUser = (name: string, role: 'customer' | 'staff' | 'admin') =>
    prisma.user.create({ data: { email: EMAIL(name), passwordHash: 'x', name: `Name ${name}`, role } })
  const [owner, other, staff, admin] = await Promise.all([
    mkUser('s6owner', 'customer'), mkUser('s6other', 'customer'), mkUser('s6staff', 'staff'), mkUser('s6admin', 'admin'),
  ])
  const mk = (userId: string, visibility: string, tag: string) => prisma.model.create({
    data: {
      title: `SECRET-TITLE-${tag}`, userId, visibility, fileType: 'stl',
      filePath: `${userId}/models/${tag}.stl`, viewerFilePath: `${userId}/models/${tag}.stl`,
      volumeMm3: 8000, sizeXmm: 20, sizeYmm: 20, sizeZmm: 20, priceUsd: 5, effectivePriceUsd: 5,
    },
  })
  const [priv, legacyPublic, legacyUnlisted, shopPub, shopUnl, shopPriv] = await Promise.all([
    mk(owner.id, 'private', 'priv'),
    mk(owner.id, 'public', 'legacyPublic'), // rows saved as "public" before this policy existed
    mk(owner.id, 'unlisted', 'legacyUnlisted'),
    mk(admin.id, 'public', 'shopPub'),
    mk(admin.id, 'unlisted', 'shopUnl'),
    mk(admin.id, 'private', 'shopPriv'),
  ])
  Object.assign(ids, {
    owner: owner.id, other: other.id, staff: staff.id, admin: admin.id,
    priv: priv.id, legacyPublic: legacyPublic.id, legacyUnlisted: legacyUnlisted.id,
    shopPub: shopPub.id, shopUnl: shopUnl.id, shopPriv: shopPriv.id,
  })
  viewers = {
    anon: null,
    owner: { id: owner.id, role: 'customer' },
    other: { id: other.id, role: 'customer' },
    staff: { id: staff.id, role: 'staff' },
    admin: { id: admin.id, role: 'admin' },
  }
})

// ---- Policy (unit) ---------------------------------------------------------------------------------
test('S6 policy: customer models are never published; only shop-owned public/unlisted models are', () => {
  const customer = { isAdmin: false, role: 'customer' }
  const shop = { isAdmin: false, role: 'admin' }
  for (const visibility of ['public', 'unlisted', 'private']) {
    assert.equal(isModelPublished({ userId: 'u', visibility, user: customer }), false, `customer/${visibility}`)
  }
  assert.equal(isModelPublished({ userId: 'u', visibility: 'public', user: shop }), true)
  assert.equal(isModelPublished({ userId: 'u', visibility: 'unlisted', user: { isAdmin: true, role: 'customer' } }), true)
  assert.equal(isModelPublished({ userId: 'u', visibility: 'private', user: shop }), false)
  assert.equal(isShopAccount(null), false)
  assert.equal(canPublishModelFor(customer), false)
  assert.equal(canPublishModelFor(shop), true)
})

test('S6 policy: view/manage matrix (anonymous, owner, other customer, staff, admin)', () => {
  const row = { userId: 'owner', visibility: 'public', user: { isAdmin: false, role: 'customer' } }
  assert.equal(canViewModel(row, null), false)
  assert.equal(canViewModel(row, { id: 'other', role: 'customer' }), false)
  assert.equal(canViewModel(row, { id: 'owner', role: 'customer' }), true)
  assert.equal(canViewModel(row, { id: 's', role: 'staff' }), true)
  assert.equal(canViewModel(row, { id: 'a', role: 'admin' }), true)
  assert.equal(canManageModel(row, { id: 'other', role: 'customer' }), false)
  assert.equal(canManageModel(row, { id: 'owner', role: 'customer' }), true)
  assert.equal(canManageModel(row, { id: 'a', role: 'admin' }), true)
  assert.equal(canManageModel(row, { id: 's', role: 'staff' }), false)
})

test('S6a: uploads are private by default and customers cannot choose otherwise', () => {
  const customerCanChoose = canChooseUploadVisibility({ role: 'customer' })
  assert.equal(customerCanChoose, false)
  assert.equal(resolveUploadVisibility('public', customerCanChoose), 'private')
  assert.equal(resolveUploadVisibility('unlisted', customerCanChoose), 'private')
  assert.equal(resolveUploadVisibility(undefined, customerCanChoose), 'private')
  assert.equal(resolveUploadVisibility(undefined, true), 'private')
})

// ---- S7: model detail API --------------------------------------------------------------------------
test('S7: private and legacy-"public" customer models return 404 to anonymous callers and other customers', async () => {
  for (const key of ['priv', 'legacyPublic', 'legacyUnlisted'] as const) {
    for (const who of ['anon', 'other'] as const) {
      const { res, text } = await detail(ids[key], viewers[who])
      assert.equal(res.status, 404, `${key} as ${who} -> HTTP ${res.status}`)
      assert.ok(!text.includes('SECRET-TITLE'), `${key} as ${who} leaked the title`)
      assert.ok(!text.includes(EMAIL('s6owner')), `${key} as ${who} leaked the owner e-mail`)
      assert.ok(!text.includes('/models/'), `${key} as ${who} leaked a stored file path`)
    }
  }
})

test('S7: a private model is indistinguishable from a non-existent id (no id probing)', async () => {
  const missing = await detail('cm0000000000000000000000x', viewers.anon)
  for (const key of ['priv', 'legacyPublic'] as const) {
    for (const who of ['anon', 'other'] as const) {
      const { res, text } = await detail(ids[key], viewers[who])
      assert.equal(res.status, missing.res.status)
      assert.equal(text, missing.text)
    }
  }
})

test('S7: owner, staff and admin can read a customer model; the owner e-mail is shown to staff only', async () => {
  for (const who of ['owner', 'staff', 'admin'] as const) {
    const { res, text } = await detail(ids.priv, viewers[who])
    assert.equal(res.status, 200, `${who} -> HTTP ${res.status}`)
    const body = JSON.parse(text)
    assert.equal(body.model.title, 'SECRET-TITLE-priv')
    if (who === 'owner') assert.equal(body.model.creator?.email, undefined, 'owner response should not echo e-mails')
    if (who === 'staff' || who === 'admin') assert.equal(body.model.creator?.email, EMAIL('s6owner'))
  }
})

test('S7: published shop models are visible to anyone but never expose e-mails, revisions or production data', async () => {
  for (const key of ['shopPub', 'shopUnl'] as const) {
    for (const who of ['anon', 'other'] as const) {
      const { res, text } = await detail(ids[key], viewers[who])
      assert.equal(res.status, 200, `${key} as ${who} -> HTTP ${res.status}`)
      assert.ok(!text.includes('@sectest.invalid'), `${key} as ${who} leaked an e-mail address`)
      const body = JSON.parse(text)
      assert.deepEqual(body.model.printTemplates, [])
      assert.deepEqual(body.model.revisions, [])
      assert.equal(res.headers.get('cache-control'), 'private, no-store')
    }
  }
  const hidden = await detail(ids.shopPriv, viewers.anon)
  assert.equal(hidden.res.status, 404)
})

// ---- Lists and discovery ---------------------------------------------------------------------------
test('S6: the public catalogue and thumbnails list only published shop models', async () => {
  as(viewers.anon)
  const { GET } = await import('../../app/api/models/route')
  const list = await (await GET(new NextRequest('http://localhost/api/models?pageSize=60'))).text()
  assert.ok(list.includes(ids.shopPub), 'published shop model missing from catalogue')
  for (const key of ['priv', 'legacyPublic', 'legacyUnlisted', 'shopUnl', 'shopPriv'] as const) {
    assert.ok(!list.includes(ids[key]), `${key} appears in the public catalogue`)
  }
  assert.ok(!list.includes('SECRET-TITLE-legacyPublic'))

  const thumbs = await import('../../app/api/models/thumbs/route')
  const thumbText = await (await thumbs.GET(new NextRequest('http://localhost/api/models/thumbs'))).text()
  assert.ok(thumbText.includes(ids.shopPub))
  assert.ok(!thumbText.includes(ids.legacyPublic) && !thumbText.includes(ids.priv))
})

test('S6: featured models never include customer models, even if an admin features one', async () => {
  const prisma = await db()
  await prisma.featuredModel.createMany({ data: [{ modelId: ids.legacyPublic }, { modelId: ids.shopPub, position: 1 }] })
  try {
    const { GET } = await import('../../app/api/featured/route')
    const text = await (await GET()).text()
    assert.ok(text.includes(ids.shopPub))
    assert.ok(!text.includes(ids.legacyPublic))
  } finally {
    await prisma.featuredModel.deleteMany()
  }
})

test('S6: store products pointing to a customer model are hidden', async () => {
  const prisma = await db()
  const bad = await prisma.productTemplate.create({ data: { title: 'PRODUCT-ON-CUSTOMER-MODEL', baseModelId: ids.legacyPublic } })
  const good = await prisma.productTemplate.create({ data: { title: 'PRODUCT-ON-SHOP-MODEL', baseModelId: ids.shopPub } })
  try {
    const { GET } = await import('../../app/api/products/route')
    const text = await (await GET()).text()
    assert.ok(text.includes('PRODUCT-ON-SHOP-MODEL'))
    assert.ok(!text.includes('PRODUCT-ON-CUSTOMER-MODEL'))
    assert.ok(!text.includes('SECRET-TITLE-legacyPublic'))
  } finally {
    await prisma.productTemplate.deleteMany({ where: { id: { in: [bad.id, good.id] } } })
  }
})

test('S6: remix/origin links never name customer models', async () => {
  const prisma = await db()
  await prisma.model.update({ where: { id: ids.legacyPublic }, data: { creditUrl: `http://x/models/${ids.shopPub}` } })
  await prisma.model.update({ where: { id: ids.shopUnl }, data: { creditUrl: `http://x/models/${ids.priv}` } })
  try {
    const forShop = await getModelLineageSummary(ids.shopPub, null)
    assert.deepEqual(forShop.remixes, [], 'a private customer remix was listed')
    const unl = await getModelLineageSummary(ids.shopUnl, `http://x/models/${ids.priv}`)
    assert.equal(unl.origin, null, 'a private customer model was named as origin')
  } finally {
    await prisma.model.update({ where: { id: ids.legacyPublic }, data: { creditUrl: null } })
    await prisma.model.update({ where: { id: ids.shopUnl }, data: { creditUrl: null } })
  }
})

// ---- Alternative APIs ------------------------------------------------------------------------------
test('S7: quote, manufacturability report and comments answer 404 for private models (and work for published ones)', async () => {
  const quote = await import('../../app/api/models/[id]/quote/route')
  const report = await import('../../app/api/models/[id]/manufacturability-report/route')
  const comments = await import('../../app/api/models/[id]/comments/route')

  const post = async (handler: any, id: string, viewer: Viewer) => {
    as(viewer)
    const req = new NextRequest(`http://localhost/api/models/${id}/x`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 1, colors: ['#ffffff'] }),
    })
    return handler(req, { params: Promise.resolve({ id }) }) as Promise<Response>
  }
  const missing = await post(quote.POST, 'cm0000000000000000000000x', viewers.anon)
  assert.equal(missing.status, 404)
  for (const [name, handler] of [['quote', quote.POST], ['report', report.POST]] as const) {
    for (const who of ['anon', 'other'] as const) {
      const res = await post(handler, ids.legacyPublic, viewers[who])
      assert.equal(res.status, 404, `${name} legacyPublic as ${who} -> HTTP ${res.status}`)
      assert.equal(await res.text(), await missing.clone().text().catch(() => '{"error":"Model not found"}'))
    }
    assert.notEqual((await post(handler, ids.priv, viewers.owner)).status, 404, `${name}: owner must still be able to use their own model`)
    assert.notEqual((await post(handler, ids.shopPub, viewers.anon)).status, 404, `${name}: published shop model must be usable by anyone`)
  }
  for (const who of ['anon', 'other'] as const) {
    const { res } = await getJson(`http://localhost/api/models/${ids.priv}/comments`, comments.GET as any, ids.priv, viewers[who])
    assert.equal(res.status, 404)
  }
  const ok = await getJson(`http://localhost/api/models/${ids.shopPub}/comments`, comments.GET as any, ids.shopPub, viewers.anon)
  assert.equal(ok.res.status, 200)
})

test('S7: download.zip refuses legacy-"public" customer models and serves published shop models', async () => {
  const { GET } = await import('../../app/api/models/[id]/download.zip/route')
  const dl = async (id: string, viewer: Viewer) => {
    as(viewer)
    const res = await (GET as any)(new NextRequest(`http://localhost/api/models/${id}/download.zip`), { params: Promise.resolve({ id }) }) as Response
    await res.body?.cancel().catch(() => {})
    return res.status
  }
  assert.equal(await dl(ids.legacyPublic, viewers.anon), 404)
  assert.equal(await dl(ids.legacyPublic, viewers.other), 404)
  assert.equal(await dl(ids.legacyPublic, viewers.owner), 200)
  assert.equal(await dl(ids.shopPub, viewers.anon), 200)
})

test('S6: checkout cannot order somebody else’s customer model, but can order a published shop model', async () => {
  await installFakeStripe({
    'paymentIntents.create': async () => ({ id: 'pi_FAKE_s6', client_secret: 'secret_FAKE' }),
  })
  const { POST } = await import('../../app/api/checkout/route')
  const quoteFor = async (modelId: string) => postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, { paymentMethod: 'card' }))
  const blocked = await quoteFor(ids.legacyPublic)
  assert.equal(blocked.status, 404, `guest checkout of a customer model -> HTTP ${blocked.status}`)
  const allowed = await quoteFor(ids.shopPub)
  assert.equal(allowed.status, 200, `guest checkout of a published shop model -> HTTP ${allowed.status}`)
})

// ---- Existing records: scripts/privatize-customer-models.js --------------------------------------
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

function runScript(args: string[]) {
  return execFileSync(process.execPath, ['scripts/privatize-customer-models.js', ...args], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL as string },
    encoding: 'utf8',
  })
}

test('data cleanup: dry run changes nothing; --apply privatizes customer models only and records the change', async () => {
  const prisma = await db()
  const outDir = path.join(process.env.STORAGE_DIR as string, 'backups')
  const visibilityOf = async (id: string) => (await prisma.model.findUnique({ where: { id }, select: { visibility: true } }))?.visibility

  const dry = runScript([])
  assert.match(dry, /DRY RUN/)
  assert.match(dry, /Customer models not marked private:\s+2/) // legacyPublic + legacyUnlisted
  assert.equal(await visibilityOf(ids.legacyPublic), 'public')
  assert.ok(!existsSync(outDir) || readdirSync(outDir).filter((f) => f.startsWith('privatize-')).length === 0, 'dry run wrote a record')

  const applied = runScript(['--apply', '--out', outDir])
  assert.match(applied, /Updated 2 model\(s\) to private/)
  assert.equal(await visibilityOf(ids.legacyPublic), 'private')
  assert.equal(await visibilityOf(ids.legacyUnlisted), 'private')
  // shop-owned models are never touched
  assert.equal(await visibilityOf(ids.shopPub), 'public')
  assert.equal(await visibilityOf(ids.shopUnl), 'unlisted')
  // nothing deleted
  assert.equal(await prisma.model.count({ where: { id: { in: [ids.legacyPublic, ids.legacyUnlisted, ids.priv] } } }), 3)
  // the change record lists what was changed and the previous values
  const record = readdirSync(outDir).find((f) => f.startsWith('privatize-customer-models-'))
  assert.ok(record, 'no change record written')
  const parsed = JSON.parse(readFileSync(path.join(outDir, record as string), 'utf8'))
  assert.deepEqual(parsed.changes.map((c: any) => c.previousVisibility).sort(), ['public', 'unlisted'])
  // idempotent
  assert.match(runScript([]), /Nothing to do/)
})
