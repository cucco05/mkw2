import path from 'path'
import { readFile } from 'fs/promises'
import { prisma } from '@/lib/db'
import { storageRoot } from '@/lib/storage'
import { serializeModelImages } from '@/lib/model-images'
import { resolveModelPricing, estimatePricingDetails } from '@/lib/pricing'
import { commentInclude, findVerifiedCommentUserIds, serializeComment } from '@/lib/comments'
import { computeStlStatsMm } from '@/lib/stl'
import { updateModelPricingForModel } from '@/lib/model-pricing'
import { computeModelIntelligence } from '@/lib/model-intelligence'
import { scaleStatsToTargetDimensions } from '@/lib/model-dimensions'
import { needsModelPreviewConversion } from '@/lib/model-files'
import { extract3mfFilamentColors } from '@/lib/model-preview-queue'
import { getCreatorQualitySnapshot } from '@/lib/creator-quality'
import { getModelLineageSummary } from '@/lib/model-lineage'
import { buildModelPrintTemplateSummary } from '@/lib/printlab-order-link'
import { buildModelGcodeTemplateSummary } from '@/lib/printlab-model-gcodes'
import { getViewableModelRow } from '@/lib/model-access'
import { isStaffViewer, type Viewer } from '@/lib/viewer'

// Loads everything the model page / API shows for ONE model, for ONE viewer.
// Authorization comes first (before any read-with-side-effects): a model the viewer may not see is
// reported exactly like a missing one (null), so ids cannot be probed. Sensitive fields are then
// trimmed to what this viewer is entitled to (see the `privileged` / `staff` flags below).
export async function loadModelDetail(id: string, viewer: Viewer): Promise<{ model: any } | null> {
  if (!(await getViewableModelRow(id, viewer))) return null
  let model = await prisma.model.findUnique({
    where: { id },
    include: {
      modelTags: { include: { tag: true } },
      images: { orderBy: { sortOrder: 'asc' } },
      comments: commentInclude,
      revisions: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { user: { select: { id: true, name: true } }, parts: { select: { id: true } } },
      },
      user: { select: { id: true, name: true, email: true, profile: { select: { slug: true, avatarImagePath: true } } } },
    },
  })
  if (!model) return null
  let [parts, cfg] = await Promise.all([
    prisma.modelPart.findMany({ where: { modelId: id }, orderBy: { index: 'asc' } }),
    prisma.siteConfig.findUnique({ where: { id: 'main' } }),
  ])
  if (!Array.isArray(model.defaultColors) || model.defaultColors.length === 0) {
    const candidates = [
      model.filePath,
      ...parts.map((part) => part.filePath),
    ].filter((p): p is string => typeof p === 'string' && p.toLowerCase().endsWith('.3mf'))
    for (const candidate of candidates) {
      try {
        const rel = candidate.replace(/^\/+/, '')
        const buf = await readFile(path.join(storageRoot(), rel))
        const parsed = await extract3mfFilamentColors(buf)
        if (parsed && parsed.length > 0) {
          await prisma.model.update({ where: { id }, data: { defaultColors: parsed } })
          ;(model as any).defaultColors = parsed
          break
        }
      } catch (err) {
        console.warn('Failed to extract default colors', err)
      }
    }
  }
  const partsNeedingStats = parts.filter((part: any) => part.previewFilePath && part.volumeMm3 == null)
  if (partsNeedingStats.length > 0) {
    for (const part of partsNeedingStats) {
      const previewRel = String(part.previewFilePath || '').replace(/^\/+/, '')
      if (!previewRel) continue
      try {
        const buf = await readFile(path.join(storageRoot(), previewRel))
        let stats = computeStlStatsMm(buf)
        stats = scaleStatsToTargetDimensions(stats, {
          x: model.sizeXmm ?? null,
          y: model.sizeYmm ?? null,
          z: model.sizeZmm ?? null,
        })
        if (stats.volumeMm3 != null) {
          await prisma.modelPart.update({
            where: { id: part.id },
            data: {
              volumeMm3: stats.volumeMm3 || undefined,
              sizeXmm: stats.sizeXmm ?? undefined,
              sizeYmm: stats.sizeYmm ?? undefined,
              sizeZmm: stats.sizeZmm ?? undefined,
              supportRatio: stats.supportAreaRatio ?? undefined,
            },
          })
        }
      } catch {
        // ignore missing preview stats
      }
    }
    if (model.viewerFilePath === model.filePath) {
      const firstPreview = parts.find((part: any) => part.index === 0 && part.previewFilePath)?.previewFilePath
      if (firstPreview) {
        await prisma.model.update({ where: { id }, data: { viewerFilePath: firstPreview } })
      }
    }
    await updateModelPricingForModel(id)
    model = await prisma.model.findUnique({
      where: { id },
      include: {
        modelTags: { include: { tag: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        comments: commentInclude,
        revisions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { user: { select: { id: true, name: true } }, parts: { select: { id: true } } },
        },
        user: { select: { id: true, name: true, email: true, profile: { select: { slug: true, avatarImagePath: true } } } },
      },
    })
    if (!model) return null
    parts = await prisma.modelPart.findMany({ where: { modelId: id }, orderBy: { index: 'asc' } })
    cfg = await prisma.siteConfig.findUnique({ where: { id: 'main' } })
  }
  const hasConvertiblePreview = parts.some((part) => needsModelPreviewConversion(path.extname(String(part.filePath || '')).toLowerCase()))
  const previewJobsPending = hasConvertiblePreview
    ? await prisma.modelPreviewJob.count({
        where: { modelId: id, status: { in: ['pending', 'processing'] } },
      })
    : 0
  let supportRatio = model.supportRatio
  if (supportRatio == null || !Number.isFinite(Number(supportRatio))) {
    let weightedSupport = 0
    let weightedVolume = 0
    for (const part of parts) {
      if (part.volumeMm3 == null || !Number.isFinite(Number(part.volumeMm3))) continue
      if (part.supportRatio == null || !Number.isFinite(Number(part.supportRatio))) continue
      const vol = Number(part.volumeMm3)
      weightedSupport += Number(part.supportRatio) * vol
      weightedVolume += vol
    }
    if (weightedVolume > 0) {
      supportRatio = weightedSupport / weightedVolume
    }
  }

  if (
    model.printabilityScore == null
    || model.failureRiskScore == null
    || model.supportLikelihood == null
    || model.orientationSuggestion == null
    || (model as any).supportStrategySuggestion == null
  ) {
    const intelligence = computeModelIntelligence({
      sizeXmm: model.sizeXmm ?? null,
      sizeYmm: model.sizeYmm ?? null,
      sizeZmm: model.sizeZmm ?? null,
      volumeMm3: model.volumeMm3 ?? null,
      supportRatio: supportRatio ?? null,
    })
    if (intelligence) {
      await prisma.model.update({
        where: { id },
        data: {
          printabilityScore: intelligence.printabilityScore,
          supportLikelihood: intelligence.supportLikelihood,
          failureRiskScore: intelligence.failureRiskScore,
          orientationSuggestion: intelligence.orientationSuggestion,
          supportStrategySuggestion: intelligence.supportStrategySuggestion,
          intelligenceUpdatedAt: new Date(),
        },
      })
      ;(model as any).printabilityScore = intelligence.printabilityScore
      ;(model as any).supportLikelihood = intelligence.supportLikelihood
      ;(model as any).failureRiskScore = intelligence.failureRiskScore
      ;(model as any).orientationSuggestion = intelligence.orientationSuggestion
      ;(model as any).supportStrategySuggestion = intelligence.supportStrategySuggestion
      ;(model as any).intelligenceUpdatedAt = new Date()
    }
  }
  const staff = isStaffViewer(viewer)
  // Owner and staff see the full detail; other viewers (only possible for published shop models) get the public subset.
  const privileged = staff || viewer?.id === model.userId
  const tags = model.modelTags.map(mt => ({ id: mt.tag.id, name: mt.tag.name, slug: mt.tag.slug }))
  const { modelTags, images, comments, revisions, user, coverImageSourcePath, coverImageError, ...rest } = model as any
  const pricingSummary = resolveModelPricing(model as any, cfg)
  const effectivePriceUsd = model.effectivePriceUsd != null && Number.isFinite(Number(model.effectivePriceUsd))
    ? Number(model.effectivePriceUsd)
    : null
  const displayPriceUsd = pricingSummary.salePriceUsd ?? effectivePriceUsd ?? pricingSummary.priceUsd
  const totalVolumeMm3 = (() => {
    if (model.volumeMm3 != null && Number.isFinite(Number(model.volumeMm3))) {
      return Number(model.volumeMm3)
    }
    const partVolumes = parts
      .map((part) => (part.volumeMm3 != null && Number.isFinite(Number(part.volumeMm3)) ? Number(part.volumeMm3) : null))
      .filter((vol): vol is number => vol != null)
    if (partVolumes.length === 0) return null
    return partVolumes.reduce((sum, vol) => sum + vol, 0)
  })()
  const totalPricing = totalVolumeMm3 != null
    ? estimatePricingDetails({
      cm3: totalVolumeMm3 / 1000,
      material: rest.material,
      supportRatio: supportRatio ?? null,
      cfg,
      applyMinimum: true,
    })
    : null
  const totalPriceForParts = pricingSummary.salePriceUsd ?? totalPricing?.price ?? pricingSummary.priceUsd ?? null
  const verifiedComments = await findVerifiedCommentUserIds(model.id, (comments || []).map((c: any) => c.userId))
  const isMultipart = parts.length > 1
  const [creatorQuality, lineage] = await Promise.all([
    getCreatorQualitySnapshot(model.userId),
    getModelLineageSummary(model.id, model.creditUrl ?? null),
  ])
  // Print templates come from other customers' completed orders and PrintLab captures: staff-only production data.
  const templateOrders = !staff ? [] : await prisma.printOrder.findMany({
    where: {
      status: { in: ['completed', 'shipped'] },
      items: { some: { modelId: id } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: {
      metadata: true,
    },
  })
  const capturedGcodes = !staff ? [] : await (prisma as any).modelGcode.findMany({
    where: { modelId: id },
    orderBy: [
      { completedAt: 'desc' },
      { capturedAt: 'desc' },
    ],
    take: 10,
  })
  const printTemplates = [
    ...capturedGcodes
      .map((record: any) => buildModelGcodeTemplateSummary(record))
      .filter((entry: any): entry is NonNullable<typeof entry> => Boolean(entry)),
    ...templateOrders
    .flatMap((order) => {
      const metadata = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
        ? order.metadata as Record<string, any>
        : {}
      const submissions = Array.isArray(metadata.printLabSubmissions) ? metadata.printLabSubmissions : []
      return submissions
        .map((submission) => buildModelPrintTemplateSummary(submission as any))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    }),
  ]
    .filter((template, index, templates) => {
      const key = template.successfulGcodeId || template.printLabJobId || `${template.filePath}:${template.completedAt}`
      return templates.findIndex((entry) => (entry.successfulGcodeId || entry.printLabJobId || `${entry.filePath}:${entry.completedAt}`) === key) === index
    })
    .sort((a, b) => {
      const materialScore = Number(b.exactMaterials.length > 0) - Number(a.exactMaterials.length > 0)
      if (materialScore !== 0) return materialScore
      return String(b.completedAt || '').localeCompare(String(a.completedAt || ''))
    })
    .slice(0, 3)
  return {
    model: {
      ...rest,
      downloadsEnabled: cfg?.allowModelDownloads !== false,
      previewProcessing: hasConvertiblePreview ? previewJobsPending > 0 : false,
      priceUsd: displayPriceUsd,
      basePriceUsd: pricingSummary.basePriceUsd,
      salePriceUsd: pricingSummary.salePriceUsd,
      pricing: pricingSummary.breakdown,
      tags,
      parts: parts.map((part) => {
        const rawPrice = part.priceUsd != null ? Number(part.priceUsd) : null
        const partPricing = part.volumeMm3 != null && Number.isFinite(Number(part.volumeMm3))
          ? estimatePricingDetails({
            cm3: Number(part.volumeMm3) / 1000,
            material: rest.material,
            supportRatio: part.supportRatio ?? null,
            cfg,
            applyMinimum: false,
          })
          : null
        const computedPrice = isMultipart && totalPriceForParts != null && totalVolumeMm3 && part.volumeMm3 && totalVolumeMm3 > 0
          ? Number(((totalPriceForParts * Number(part.volumeMm3)) / totalVolumeMm3).toFixed(2))
          : ((rawPrice != null && Number.isFinite(rawPrice)) ? rawPrice : (partPricing?.price ?? null))
        return {
          ...part,
          priceUsd: computedPrice,
          pricing: partPricing,
        }
      }),
      images: serializeModelImages(images),
      comments: (comments || []).map((comment: any) => serializeComment({
        ...comment,
        isVerified: comment.userId ? verifiedComments.has(comment.userId) : false,
      })),
      revisions: (privileged ? (revisions || []) : []).map((rev: any) => ({
        id: rev.id,
        version: rev.version,
        label: rev.label,
        note: rev.note,
        createdAt: rev.createdAt,
        user: rev.user ? { id: rev.user.id, name: rev.user.name } : null,
        partsCount: Array.isArray(rev.parts) ? rev.parts.length : 0,
      })),
      creator: user ? {
        id: user.id,
        name: user.name,
        email: staff ? user.email : undefined,
        profileSlug: user.profile?.slug || null,
        avatarImagePath: user.profile?.avatarImagePath || null,
        quality: creatorQuality,
      } : null,
      lineage,
      printTemplates,
    },
  }
}
