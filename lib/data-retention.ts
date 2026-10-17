import path from 'path'
import { unlink } from 'fs/promises'
import { prisma } from '@/lib/db'
import { storageRoot } from '@/lib/storage'
import { PAYMENT_IN_DOUBT_SQL } from '@/lib/payment-in-doubt'

export type RetentionPolicy = {
  uploadsDays: number
  logsDays: number
  messagesDays: number
  // how long the hash of a guest's browser session stays on an order, and the per-session request counters stay in the table: longer than the life of the
  // session cookie itself (30 days, lib/guest-session.ts), so it is never emptied while the browser could still present that session
  guestSessionDays: number
}

export type RetentionCleanupSummary = {
  dryRun: boolean
  policy: RetentionPolicy
  modelsCoverSourceCleared: number
  modelImageSourceCleared: number
  profileAvatarSourceCleared: number
  commentImageSourceCleared: number
  printOrderMessagesDeleted: number
  modelCommentsDeleted: number
  rateLimitEntriesDeleted: number
  configLogsDeleted: number
  filesDeleted: number
  guestSessionHashesCleared: number
  guestRateLimitEntriesDeleted: number
}

function readPositiveInt(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export function getRetentionPolicy(): RetentionPolicy {
  return {
    uploadsDays: readPositiveInt('DATA_RETENTION_UPLOAD_DAYS', 90),
    logsDays: readPositiveInt('DATA_RETENTION_LOG_DAYS', 180),
    messagesDays: readPositiveInt('DATA_RETENTION_MESSAGE_DAYS', 365),
    guestSessionDays: readPositiveInt('DATA_RETENTION_GUEST_SESSION_DAYS', 45),
  }
}

function resolveStorageFile(input: string | null | undefined) {
  if (!input) return null
  const normalized = String(input).trim().replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) return null
  return path.join(storageRoot(), normalized)
}

async function deleteFiles(paths: Array<string | null | undefined>, dryRun: boolean) {
  let filesDeleted = 0
  const unique = new Set(paths.map(resolveStorageFile).filter((entry): entry is string => Boolean(entry)))
  if (dryRun) return { filesDeleted: unique.size }
  for (const filePath of unique) {
    try {
      await unlink(filePath)
      filesDeleted += 1
    } catch {
      // best-effort cleanup
    }
  }
  return { filesDeleted }
}

export async function runDataRetentionCleanup(input?: { dryRun?: boolean }) {
  const dryRun = Boolean(input?.dryRun)
  const policy = getRetentionPolicy()
  const now = Date.now()
  const uploadsCutoff = new Date(now - policy.uploadsDays * 24 * 60 * 60 * 1000)
  const logsCutoff = new Date(now - policy.logsDays * 24 * 60 * 60 * 1000)
  const messagesCutoff = new Date(now - policy.messagesDays * 24 * 60 * 60 * 1000)
  const guestSessionCutoff = new Date(now - policy.guestSessionDays * 24 * 60 * 60 * 1000)

  const [models, modelImages, profiles, makeComments] = await Promise.all([
    prisma.model.findMany({
      where: {
        coverImageSourcePath: { not: null },
        updatedAt: { lt: uploadsCutoff },
        NOT: { coverImageStatus: 'processing' },
      },
      select: { id: true, coverImageSourcePath: true },
      take: 5000,
    }),
    prisma.modelImage.findMany({
      where: {
        sourcePath: { not: null },
        createdAt: { lt: uploadsCutoff },
        NOT: { status: 'processing' },
      },
      select: { id: true, sourcePath: true },
      take: 10000,
    }),
    prisma.profile.findMany({
      where: {
        avatarImageSourcePath: { not: null },
        createdAt: { lt: uploadsCutoff },
        NOT: { avatarImageStatus: 'processing' },
      },
      select: { userId: true, avatarImageSourcePath: true },
      take: 5000,
    }),
    prisma.modelComment.findMany({
      where: {
        imageSourcePath: { not: null },
        updatedAt: { lt: uploadsCutoff },
        NOT: { imageStatus: 'processing' },
      },
      select: { id: true, imageSourcePath: true },
      take: 10000,
    }),
  ])

  const sourcePaths = [
    ...models.map((row) => row.coverImageSourcePath),
    ...modelImages.map((row) => row.sourcePath),
    ...profiles.map((row) => row.avatarImageSourcePath),
    ...makeComments.map((row) => row.imageSourcePath),
  ]
  const fileDeleteResult = await deleteFiles(sourcePaths, dryRun)

  let modelsCoverSourceCleared = models.length
  let modelImageSourceCleared = modelImages.length
  let profileAvatarSourceCleared = profiles.length
  let commentImageSourceCleared = makeComments.length
  let printOrderMessagesDeleted = 0
  let modelCommentsDeleted = 0
  let rateLimitEntriesDeleted = 0
  let configLogsDeleted = 0
  let guestSessionHashesCleared = 0
  let guestRateLimitEntriesDeleted = 0

  // The hash of a guest's browser session (step 4.6, S5) on an order is of no use once the session cookie is long gone - EXCEPT on an order whose payment is in
  // doubt (being confirmed, or waiting for a person): there it is what lets the server recognise the same browser and refuse a second payment of the same cart, with
  // no time limit (lib/checkout-orders.ts). Those keep it. ONLY that column is emptied: not the metadata, not the review reason, not the payment markers, not the
  // access token - and not `updatedAt`, which customers see: the statement is written by hand so that nothing else on the order moves. Deciding and writing are one
  // statement, so an order can not slip into doubt between the two.
  const guestCounters = { AND: [{ key: { startsWith: 'checkout:' } }, { key: { contains: ':guest:' } }], updatedAt: { lt: guestSessionCutoff } }
  if (dryRun) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS "count" FROM "PrintOrder"
      WHERE "guestSessionHash" IS NOT NULL AND "createdAt" < ${guestSessionCutoff} AND NOT ${PAYMENT_IN_DOUBT_SQL}`
    guestSessionHashesCleared = Number(rows[0]?.count ?? 0)
    guestRateLimitEntriesDeleted = await prisma.rateLimit.count({ where: guestCounters })
  } else {
    guestSessionHashesCleared = await prisma.$executeRaw`
      UPDATE "PrintOrder" SET "guestSessionHash" = NULL
      WHERE "guestSessionHash" IS NOT NULL AND "createdAt" < ${guestSessionCutoff} AND NOT ${PAYMENT_IN_DOUBT_SQL}`
    // the per-session request counters are named by that same hash: they go when it goes
    guestRateLimitEntriesDeleted = (await prisma.rateLimit.deleteMany({ where: guestCounters })).count
  }

  if (!dryRun) {
    const [poMsgDelete, modelCommentDelete, rateLimitDelete, configDelete] = await Promise.all([
      prisma.printOrderMessage.deleteMany({ where: { createdAt: { lt: messagesCutoff } } }),
      prisma.modelComment.deleteMany({ where: { createdAt: { lt: messagesCutoff } } }),
      prisma.rateLimit.deleteMany({ where: { updatedAt: { lt: logsCutoff } } }),
      prisma.configChangeLog.deleteMany({ where: { createdAt: { lt: logsCutoff } } }),
    ])
    printOrderMessagesDeleted = poMsgDelete.count
    modelCommentsDeleted = modelCommentDelete.count
    rateLimitEntriesDeleted = rateLimitDelete.count
    configLogsDeleted = configDelete.count

    if (models.length > 0) {
      await prisma.model.updateMany({
        where: { id: { in: models.map((row) => row.id) } },
        data: { coverImageSourcePath: null },
      })
    }
    if (modelImages.length > 0) {
      await prisma.modelImage.updateMany({
        where: { id: { in: modelImages.map((row) => row.id) } },
        data: { sourcePath: null },
      })
    }
    if (profiles.length > 0) {
      await prisma.profile.updateMany({
        where: { userId: { in: profiles.map((row) => row.userId) } },
        data: { avatarImageSourcePath: null },
      })
    }
    if (makeComments.length > 0) {
      await prisma.modelComment.updateMany({
        where: { id: { in: makeComments.map((row) => row.id) } },
        data: { imageSourcePath: null },
      })
    }
  }

  return {
    dryRun,
    policy,
    modelsCoverSourceCleared,
    modelImageSourceCleared,
    profileAvatarSourceCleared,
    commentImageSourceCleared,
    printOrderMessagesDeleted,
    modelCommentsDeleted,
    rateLimitEntriesDeleted,
    configLogsDeleted,
    filesDeleted: fileDeleteResult.filesDeleted,
    guestSessionHashesCleared,
    guestRateLimitEntriesDeleted,
  } satisfies RetentionCleanupSummary
}
