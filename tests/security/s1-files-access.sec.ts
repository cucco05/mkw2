// S1 regression tests – access control for files stored under STORAGE_DIR.
// Covers: /files route (authorization, path traversal, symlinks, caching), CDN redirect bypass, download.zip.
// Originally these tests reproduced the vulnerability (todo); they now guard the fixed behaviour.
import { OUTSIDE_FILE, STORAGE_DIR, db, resetDb, writeOutsideFile, writeStorageFile } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { fileRouteGuards, type FileViewer } from '../../lib/file-access'
import { toPublicHref } from '../../lib/public-path'

type Ids = Record<'owner' | 'other' | 'staff' | 'admin' | 'publicModel' | 'privateModel' | 'unlistedModel' | 'legacyModel' | 'ownOrder' | 'guestOrder', string>
let ids: Ids
let viewers: Record<'anon' | 'owner' | 'other' | 'staff' | 'admin', FileViewer>

async function getFile(segments: string[], viewer: FileViewer) {
  const { GET } = await import('../../app/files/[...path]/route')
  fileRouteGuards.getViewer = async () => viewer
  const res = await GET(new NextRequest(`http://localhost/files/${segments.join('/')}`), { params: Promise.resolve({ path: segments }) })
  const body = res.status === 200 ? await res.text() : ''
  return { res, body }
}

const seg = (p: string) => p.split('/')

test.before(async () => {
  await resetDb()
  const prisma = await db()
  const mkUser = (name: string, role: 'customer' | 'staff' | 'admin') =>
    prisma.user.create({ data: { email: `${name}@sectest.invalid`, passwordHash: 'x', name, role } })
  const [owner, other, staff, admin] = await Promise.all([
    mkUser('s1owner', 'customer'), mkUser('s1other', 'customer'), mkUser('s1staff', 'staff'), mkUser('s1admin', 'admin'),
  ])

  // Published models belong to the SHOP (admin); customer models are private whatever is stored in `visibility`.
  const mkModel = (ownerId: string, visibility: string, tag: string) => prisma.model.create({
    data: {
      title: `FAKE ${tag}`,
      userId: ownerId,
      visibility,
      fileType: 'stl',
      filePath: `${ownerId}/models/${tag}.stl`,
      viewerFilePath: `${ownerId}/models/${tag}-preview.stl`,
      coverImagePath: `${ownerId}/thumbnails/${tag}-cover.webp`,
      images: { create: [{ filePath: `${ownerId}/gallery/${tag}-1.webp` }] },
    },
  })
  const [pub, unl, priv, legacy] = await Promise.all([
    mkModel(admin.id, 'public', 'pub'),
    mkModel(admin.id, 'unlisted', 'unl'),
    mkModel(owner.id, 'private', 'priv'),
    mkModel(owner.id, 'public', 'legacy'), // old row: a customer model saved as "public" before the privacy policy
  ])
  for (const tag of ['pub', 'unl']) {
    for (const f of [`models/${tag}.stl`, `models/${tag}-preview.stl`, `thumbnails/${tag}-cover.webp`, `gallery/${tag}-1.webp`]) {
      writeStorageFile(`${admin.id}/${f}`, `FAKE-${tag}-${f}`)
    }
  }
  for (const tag of ['priv', 'legacy']) {
    for (const f of [`models/${tag}.stl`, `models/${tag}-preview.stl`, `thumbnails/${tag}-cover.webp`, `gallery/${tag}-1.webp`]) {
      writeStorageFile(`${owner.id}/${f}`, `FAKE-${tag}-${f}`)
    }
  }
  writeStorageFile(`${owner.id}/uploads/cover-raw-1.png`, 'FAKE-RAW-COVER')
  writeStorageFile(`${owner.id}/gallery/raw/pub-raw.png`, 'FAKE-RAW-GALLERY')
  writeStorageFile(`${owner.id}/avatars/1.webp`, 'FAKE-AVATAR')

  // An order of `owner`, whose item points to a file in ANOTHER user's private folder (e.g. made by an admin).
  const ownOrder = await prisma.printOrder.create({
    data: {
      userId: owner.id, status: 'queued', paymentStatus: 'paid', subtotalCents: 100, totalCents: 100,
      items: { create: [{ modelTitle: 'x', material: 'PLA', unitPriceCents: 100, totalCents: 100, thumbnailPath: `${admin.id}/thumbnails/for-order.webp` }] },
    },
  })
  const guestOrder = await prisma.printOrder.create({ data: { userId: null, status: 'queued', paymentStatus: 'paid', subtotalCents: 100, totalCents: 100 } })
  writeStorageFile(`${admin.id}/thumbnails/for-order.webp`, 'FAKE-ORDER-THUMB')
  writeStorageFile(`orders/${ownOrder.id}/receipts/r.pdf`, 'FAKE-OWN-RECEIPT')
  writeStorageFile(`orders/${guestOrder.id}/receipts/r.pdf`, 'FAKE-GUEST-RECEIPT')
  writeStorageFile('backups/20260101T000000Z/db.sql', 'FAKE-DATABASE-DUMP')
  writeStorageFile('merch/shirt.webp', 'FAKE-MERCH')
  writeStorageFile('failure-photos/1.jpg', 'FAKE-FAILURE')
  writeStorageFile('zips/m1/1.zip', 'FAKE-ZIP')
  writeOutsideFile('FAKE-FILE-OUTSIDE-STORAGE')

  ids = {
    owner: owner.id, other: other.id, staff: staff.id, admin: admin.id,
    publicModel: pub.id, privateModel: priv.id, unlistedModel: unl.id, legacyModel: legacy.id, ownOrder: ownOrder.id, guestOrder: guestOrder.id,
  }
  viewers = {
    anon: null,
    owner: { id: owner.id, role: 'customer' },
    other: { id: other.id, role: 'customer' },
    staff: { id: staff.id, role: 'staff' },
    admin: { id: admin.id, role: 'admin' },
  }
})

test('control: harness uses an isolated storage directory', () => {
  assert.ok(STORAGE_DIR.includes('mkw-sectest-'))
})

// ---- Anonymous visitors ----------------------------------------------------------------------------
test('anonymous: private model files, backups, receipts and internal folders are refused (401)', async () => {
  const forbidden = [
    `${ids.owner}/models/priv.stl`,
    `${ids.owner}/models/priv-preview.stl`,
    `${ids.owner}/thumbnails/priv-cover.webp`,
    `${ids.owner}/uploads/cover-raw-1.png`,
    `${ids.owner}/avatars/1.webp`,
    'backups/20260101T000000Z/db.sql',
    `orders/${ids.ownOrder}/receipts/r.pdf`,
    'failure-photos/1.jpg',
    'zips/m1/1.zip',
  ]
  for (const p of forbidden) {
    const { res, body } = await getFile(seg(p), viewers.anon)
    assert.equal(res.status, 401, `${p} -> HTTP ${res.status}`)
    assert.equal(body, '', `${p} leaked content`)
  }
})

test('anonymous: no existence oracle – missing private paths answer exactly like existing ones', async () => {
  const existing = await getFile(seg(`${ids.owner}/models/priv.stl`), viewers.anon)
  const missing = await getFile(seg(`${ids.owner}/models/does-not-exist.stl`), viewers.anon)
  assert.equal(existing.res.status, missing.res.status)
})

test('anonymous: display assets of PUBLIC and UNLISTED shop models stay available (3D viewer, covers, gallery)', async () => {
  for (const tag of ['pub', 'unl']) {
    for (const p of [`models/${tag}-preview.stl`, `thumbnails/${tag}-cover.webp`, `gallery/${tag}-1.webp`, `models/${tag}.stl`]) {
      const { res, body } = await getFile(seg(`${ids.admin}/${p}`), viewers.anon)
      assert.equal(res.status, 200, `${p} -> HTTP ${res.status}`)
      assert.ok(body.startsWith('FAKE-'))
      assert.match(res.headers.get('cache-control') || '', /public/)
    }
  }
})

test('anonymous: raw uploads/avatars are never public, even next to a published model', async () => {
  writeStorageFile(`${ids.admin}/uploads/cover-raw-9.png`, 'FAKE-SHOP-RAW')
  for (const p of [`${ids.owner}/uploads/cover-raw-1.png`, `${ids.owner}/gallery/raw/pub-raw.png`, `${ids.owner}/avatars/1.webp`, `${ids.admin}/uploads/cover-raw-9.png`]) {
    const { res } = await getFile(seg(p), viewers.anon)
    assert.equal(res.status, 401, `${p} -> HTTP ${res.status}`)
  }
})

test('legacy rows: a CUSTOMER model stored as "public" is still private (no data change needed)', async () => {
  for (const p of ['models/legacy.stl', 'models/legacy-preview.stl', 'thumbnails/legacy-cover.webp', 'gallery/legacy-1.webp']) {
    const anon = await getFile(seg(`${ids.owner}/${p}`), viewers.anon)
    assert.equal(anon.res.status, 401, `${p} anonymous -> HTTP ${anon.res.status}`)
    const other = await getFile(seg(`${ids.owner}/${p}`), viewers.other)
    assert.equal(other.res.status, 404, `${p} other customer -> HTTP ${other.res.status}`)
    const owner = await getFile(seg(`${ids.owner}/${p}`), viewers.owner)
    assert.equal(owner.res.status, 200, `${p} owner -> HTTP ${owner.res.status}`)
  }
})

test('anonymous: storefront (merch) images are public', async () => {
  const { res } = await getFile(['merch', 'shirt.webp'], viewers.anon)
  assert.equal(res.status, 200)
})

test('a model made private immediately stops being public', async () => {
  const prisma = await db()
  await prisma.model.update({ where: { id: ids.publicModel }, data: { visibility: 'private' } })
  try {
    const { res } = await getFile(seg(`${ids.admin}/models/pub-preview.stl`), viewers.anon)
    assert.equal(res.status, 401)
  } finally {
    await prisma.model.update({ where: { id: ids.publicModel }, data: { visibility: 'public' } })
  }
})

// ---- Signed-in customers ---------------------------------------------------------------------------
test('owner: can read own private files, receipt and raw uploads', async () => {
  for (const p of [`${ids.owner}/models/priv.stl`, `${ids.owner}/uploads/cover-raw-1.png`, `orders/${ids.ownOrder}/receipts/r.pdf`]) {
    const { res, body } = await getFile(seg(p), viewers.owner)
    assert.equal(res.status, 200, `${p} -> HTTP ${res.status}`)
    assert.ok(body.startsWith('FAKE-'))
  }
})

test('owner: private files are never cached publicly', async () => {
  const { res } = await getFile(seg(`${ids.owner}/models/priv.stl`), viewers.owner)
  const cc = res.headers.get('cache-control') || ''
  assert.match(cc, /private/)
  assert.match(cc, /no-store/)
  assert.doesNotMatch(cc, /public/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('another customer: cannot read the owner’s private files or receipts (404, no content)', async () => {
  for (const p of [
    `${ids.owner}/models/priv.stl`, `${ids.owner}/uploads/cover-raw-1.png`, `${ids.owner}/avatars/1.webp`,
    `orders/${ids.ownOrder}/receipts/r.pdf`, 'backups/20260101T000000Z/db.sql', 'failure-photos/1.jpg', 'zips/m1/1.zip',
  ]) {
    const { res, body } = await getFile(seg(p), viewers.other)
    assert.equal(res.status, 404, `${p} -> HTTP ${res.status}`)
    assert.equal(body, '')
  }
})

test('customer: files attached to their own order stay readable even if stored in another user folder', async () => {
  const mine = await getFile(seg(`${ids.admin}/thumbnails/for-order.webp`), viewers.owner)
  assert.equal(mine.res.status, 200)
  const notMine = await getFile(seg(`${ids.admin}/thumbnails/for-order.webp`), viewers.other)
  assert.equal(notMine.res.status, 404)
})

test('guest orders (no owner) are readable by staff only', async () => {
  const p = `orders/${ids.guestOrder}/receipts/r.pdf`
  assert.equal((await getFile(seg(p), viewers.owner)).res.status, 404)
  assert.equal((await getFile(seg(p), viewers.anon)).res.status, 401)
  assert.equal((await getFile(seg(p), viewers.staff)).res.status, 200)
})

// ---- Staff and administrators ----------------------------------------------------------------------
test('staff and admin can open customer files; only admin can open backups', async () => {
  const customerFile = seg(`${ids.owner}/models/priv.stl`)
  assert.equal((await getFile(customerFile, viewers.staff)).res.status, 200)
  assert.equal((await getFile(customerFile, viewers.admin)).res.status, 200)
  const backup = seg('backups/20260101T000000Z/db.sql')
  assert.equal((await getFile(backup, viewers.staff)).res.status, 404)
  assert.equal((await getFile(backup, viewers.admin)).res.status, 200)
})

// ---- Path traversal / escaping the storage directory -----------------------------------------------
test('path traversal variants are refused even for administrators', async () => {
  const outside = path.basename(OUTSIDE_FILE)
  const attempts: string[][] = [
    ['..', outside],
    ['models', `../../${outside}`], // reaches the handler over real HTTP as /files/models/..%2f..%2foutside…
    [ids.owner, '..', '..', outside],
    ['models\\..\\..\\' + outside],
    ['.env'],
    [ids.owner, '.hidden'],
    ['', 'x'],
    ['a\u0000b'],
    [],
  ]
  for (const segs of attempts) {
    const { res, body } = await getFile(segs, viewers.admin)
    assert.notEqual(res.status, 200, `traversal ${JSON.stringify(segs)} was served: "${body}"`)
    assert.ok(!body.includes('OUTSIDE'), `traversal ${JSON.stringify(segs)} leaked outside content`)
  }
})

test('a symbolic link inside storage cannot be used to read outside it', async () => {
  mkdirSync(path.join(STORAGE_DIR, ids.owner, 'models'), { recursive: true })
  symlinkSync(OUTSIDE_FILE, path.join(STORAGE_DIR, ids.owner, 'models', 'link.stl'))
  for (const v of [viewers.owner, viewers.admin]) {
    const { res, body } = await getFile(seg(`${ids.owner}/models/link.stl`), v)
    assert.equal(res.status, 404)
    assert.equal(body, '')
  }
})

test('unknown top-level folders are denied to customers (default deny)', async () => {
  writeStorageFile('misc/notes.txt', 'FAKE-MISC')
  assert.equal((await getFile(['misc', 'notes.txt'], viewers.owner)).res.status, 404)
  assert.equal((await getFile(['misc', 'notes.txt'], viewers.anon)).res.status, 401)
})

// ---- Alternative access routes ---------------------------------------------------------------------
test('CDN base URL setting can no longer bypass the access check (no redirect, URLs stay same-origin)', async () => {
  process.env.FILES_BASE_URL = 'https://cdn.invalid'
  process.env.NEXT_PUBLIC_FILES_BASE_URL = 'https://cdn.invalid'
  try {
    const { res } = await getFile(seg(`${ids.owner}/models/priv.stl`), viewers.anon)
    assert.equal(res.status, 401)
    assert.notEqual(res.status, 302)
    assert.equal(toPublicHref(`${ids.owner}/models/priv.stl`), `/files/${ids.owner}/models/priv.stl`)
  } finally {
    delete process.env.FILES_BASE_URL
    delete process.env.NEXT_PUBLIC_FILES_BASE_URL
  }
})

async function downloadZip(modelId: string, viewer: FileViewer) {
  const { GET } = await import('../../app/api/models/[id]/download.zip/route')
  fileRouteGuards.getViewer = async () => viewer
  const res = await GET(new NextRequest(`http://localhost/api/models/${modelId}/download.zip`), { params: Promise.resolve({ id: modelId }) })
  await res.body?.cancel().catch(() => {})
  return res
}

test('download.zip: private models are refused to anonymous visitors and other customers', async () => {
  assert.equal((await downloadZip(ids.privateModel, viewers.anon)).status, 404)
  assert.equal((await downloadZip(ids.privateModel, viewers.other)).status, 404)
})

test('download.zip: owner and staff can download a private model; public models stay downloadable', async () => {
  assert.equal((await downloadZip(ids.privateModel, viewers.owner)).status, 200)
  assert.equal((await downloadZip(ids.privateModel, viewers.staff)).status, 200)
  assert.equal((await downloadZip(ids.publicModel, viewers.anon)).status, 200)
})
