import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { canManageModel } from '@/lib/model-access'
import { loadModelDetail } from '@/lib/model-detail'
import { viewerGuards } from '@/lib/viewer'
import { unlink } from 'fs/promises'
import { getUserIdFromCookie } from '@/lib/auth'
import { saveBuffer, storageRoot } from '@/lib/storage'
import path from 'path'
import { revalidatePath, revalidateTag } from 'next/cache'
import { computeEffectivePriceUsd } from '@/lib/pricing-cache'
import { enqueueImageProcessing } from '@/lib/processing-jobs'
import { CACHE_TAGS, modelCommentsTag, modelTag } from '@/lib/cache-policy'

type ModelRouteContext = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: ModelRouteContext) {
  const { id } = await params
  const viewer = await viewerGuards.getViewer()
  const detail = await loadModelDetail(id, viewer)
  // Same answer for a missing model and for one the viewer may not see.
  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE })
  return NextResponse.json(detail, { headers: NO_STORE })
}

export async function PATCH(req: NextRequest, { params }: ModelRouteContext) {
  const { id } = await params
  const userId = await getUserIdFromCookie()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const existing = await prisma.model.findUnique({
    where: { id },
    select: {
      userId: true,
      coverImagePath: true,
      volumeMm3: true,
      material: true,
      supportRatio: true,
      priceUsd: true,
      salePriceUsd: true,
    },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Allow owner or admin
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } })
  if (!canManageModel(existing, { id: userId, role: me?.isAdmin ? 'admin' : 'customer' })) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ct = req.headers.get('content-type') || ''
  let title: string | undefined
  let description: string | undefined
  let material: string | undefined
  let creditName: string | undefined
  let creditUrl: string | undefined
  let removeCover = false
  let image: File | null = null

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData()
    title = (form.get('title') as string | null) || undefined
    description = (form.get('description') as string | null) || undefined
    material = (form.get('material') as string | null) || undefined
    creditName = (form.get('creditName') as string | null) || undefined
    creditUrl = (form.get('creditUrl') as string | null) || undefined
    const rc = (form.get('removeCover') as string | null) || 'false'
    removeCover = rc === '1' || rc === 'true'
    image = (form.get('cover') as File | null) || null
  } else {
    try {
      const json = await req.json()
      title = typeof json.title === 'string' ? json.title : undefined
      description = typeof json.description === 'string' ? json.description : undefined
      material = typeof json.material === 'string' ? json.material : undefined
      creditName = typeof json.creditName === 'string' ? json.creditName : undefined
      creditUrl = typeof json.creditUrl === 'string' ? json.creditUrl : undefined
      removeCover = json.removeCover === true
    } catch {
      // ignore
    }
  }

  const updates: any = {}
  if (title != null) updates.title = String(title).slice(0, 200)
  if (description != null) updates.description = String(description).slice(0, 5000)
  if (material != null) updates.material = String(material).slice(0, 40)
  if (creditName != null) {
    const trimmed = String(creditName).trim()
    updates.creditName = trimmed ? trimmed.slice(0, 200) : null
  }
  if (creditUrl != null) {
    const trimmed = String(creditUrl).trim()
    updates.creditUrl = trimmed ? trimmed.slice(0, 500) : null
  }

  if (removeCover && existing.coverImagePath) {
    try { await unlink(path.join(storageRoot(), existing.coverImagePath.replace(/^\/+/, ''))) } catch {}
    updates.coverImagePath = null
  }

  if (image) {
    const buf = Buffer.from(await image.arrayBuffer())
    if (buf.length === 0) {
      return NextResponse.json({ error: 'Image upload failed' }, { status: 400 })
    }
    const ext = path.extname(image.name) || '.bin'
    const sourceRel = path.join(userId, 'uploads', `cover-raw-${Date.now()}${ext}`)
    await saveBuffer(sourceRel, buf)
    const rel = path.join(userId, 'thumbnails', `${Date.now()}-cover.webp`)
    if (existing.coverImagePath) {
      try { await unlink(path.join(storageRoot(), existing.coverImagePath.replace(/^\/+/, ''))) } catch {}
    }
    updates.coverImagePath = `/${rel.replace(/\\/g, '/')}`
    updates.coverImageStatus = 'processing'
    updates.coverImageSourcePath = `/${sourceRel.replace(/\\/g, '/')}`
  }

  if (material != null) {
    const cfg = await prisma.siteConfig.findUnique({ where: { id: 'main' } })
    const effectivePriceUsd = computeEffectivePriceUsd({
      id,
      volumeMm3: existing.volumeMm3,
      material: updates.material ?? existing.material,
      supportRatio: existing.supportRatio,
      priceUsd: existing.priceUsd,
      salePriceUsd: existing.salePriceUsd,
    }, cfg)
    updates.effectivePriceUsd = effectivePriceUsd
    updates.effectivePriceUpdatedAt = new Date()
  }

  const updated = await prisma.model.update({ where: { id }, data: updates })
  if (image) {
    void enqueueImageProcessing({
      modelId: id,
      includeAvatars: false,
      includeComments: false,
      limit: 1,
      idempotencyKey: `image:model:${id}`,
    }).catch((err) => {
      console.warn('Failed to process cover image', err)
    })
  }
  try {
    revalidatePath(`/models/${id}`)
    revalidatePath('/discover')
    revalidatePath('/')
    revalidateTag(modelTag(id), 'max')
    revalidateTag(modelCommentsTag(id), 'max')
    revalidateTag(CACHE_TAGS.discoverModels, 'max')
    revalidateTag(CACHE_TAGS.featuredModels, 'max')
    revalidateTag(CACHE_TAGS.homePage, 'max')
  } catch {
    // ignore revalidation errors
  }
  return NextResponse.json({ model: updated })
}
