// Access policy for files stored under STORAGE_DIR (served by app/files/[...path]).
//
// Principles:
//  - DEFAULT DENY: a file is readable only if a rule below explicitly allows it.
//  - Decisions are made from the requested path + the database BEFORE the filesystem is touched,
//    so a response never reveals whether a forbidden file exists.
//  - Path validation + realpath containment prevent leaving STORAGE_DIR (traversal, symlinks).
//
// Storage layout (see the writers in app/api/* and lib/*):
//   <userId>/{models,thumbnails,gallery,uploads,avatars,makes}/...   user-owned files
//   orders/<orderId>/...                                              receipts, reports, order attachments
//   merch/...                                                         storefront images curated by admins
//   failure-photos/..., zips/..., backups/...                         internal
import { realpath, stat } from 'fs/promises'
import path from 'path'
import { getUserIdFromCookie } from '@/lib/auth'
import { prisma } from '@/lib/db'

export type FileViewer = { id: string; role: 'admin' | 'staff' | 'customer' } | null
export type FileAccess = { allow: true; scope: 'public' | 'private' } | { allow: false }

const PUBLIC: FileAccess = { allow: true, scope: 'public' }
const PRIVATE: FileAccess = { allow: true, scope: 'private' }
const DENY: FileAccess = { allow: false }

// Models in these states are shown to visitors, so their display assets (cover, gallery, viewer files) are public.
export const PUBLIC_MODEL_VISIBILITIES = ['public', 'unlisted']
// Only these per-user folders can hold display assets of a public model. `uploads`, `avatars`, `makes` and any `raw` folder never can.
const PUBLIC_ASSET_FOLDERS = new Set(['models', 'thumbnails', 'gallery'])

export const fileRouteGuards = {
  // Overridable in tests (route handlers cannot read cookies outside a request).
  async getViewer(): Promise<FileViewer> {
    const userId = await getUserIdFromCookie()
    if (!userId) return null
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, isAdmin: true, role: true } })
    if (!user) return null
    const role = user.isAdmin || user.role === 'admin' ? 'admin' : user.role === 'staff' ? 'staff' : 'customer'
    return { id: user.id, role }
  },
}

function hasControlChars(value: string) {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true
  }
  return false
}

// Returns a clean relative path ("a/b/c") or null when any segment is suspicious.
export function normalizeStorageRelPath(segments: string[]): string | null {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 12) return null
  for (const seg of segments) {
    if (typeof seg !== 'string' || seg.length === 0 || seg.length > 255) return null
    if (seg.startsWith('.')) return null // '.', '..' and hidden files
    if (seg.includes('/') || seg.includes('\\') || hasControlChars(seg)) return null
  }
  return segments.join('/')
}

function isInside(root: string, candidate: string) {
  return candidate.startsWith(root + path.sep)
}

// Resolves a validated relative path to a real file that is guaranteed to live inside `root`
// (symbolic links are followed and re-checked). Returns null otherwise.
export async function resolveStorageFile(root: string, rel: string): Promise<{ full: string; size: number } | null> {
  try {
    const realRoot = await realpath(root)
    const candidate = path.resolve(realRoot, rel)
    if (!isInside(realRoot, candidate)) return null
    const real = await realpath(candidate)
    if (!isInside(realRoot, real)) return null
    const st = await stat(real)
    return st.isFile() ? { full: real, size: st.size } : null
  } catch {
    return null
  }
}

function pathVariants(rel: string) {
  // Paths are stored in the database with or without a leading slash.
  return [rel, `/${rel}`]
}

async function isPublicModelAsset(rel: string) {
  const variants = pathVariants(rel)
  const hit = await prisma.model.findFirst({
    where: {
      visibility: { in: PUBLIC_MODEL_VISIBILITIES },
      OR: [
        { coverImagePath: { in: variants } },
        { viewerFilePath: { in: variants } },
        { filePath: { in: variants } },
        { images: { some: { filePath: { in: variants } } } },
        { parts: { some: { OR: [{ filePath: { in: variants } }, { previewFilePath: { in: variants } }] } } },
      ],
    },
    select: { id: true },
  })
  return Boolean(hit)
}

// Thumbnails / viewer files attached to the viewer's own orders.
async function isOwnOrderItemFile(userId: string, rel: string) {
  const variants = pathVariants(rel)
  const hit = await prisma.printOrderItem.findFirst({
    where: {
      order: { userId },
      OR: [{ thumbnailPath: { in: variants } }, { viewerPath: { in: variants } }],
    },
    select: { id: true },
  })
  return Boolean(hit)
}

export async function authorizeStorageFile(rel: string, viewer: FileViewer): Promise<FileAccess> {
  const segs = rel.split('/')
  const top = segs[0]
  const isAdmin = viewer?.role === 'admin'
  const isStaff = isAdmin || viewer?.role === 'staff'

  // Database backups contain password hashes and customer data: administrators only (not even staff).
  if (top === 'backups') return isAdmin ? PRIVATE : DENY
  // Storefront images uploaded by admins are public by design.
  if (top === 'merch') return PUBLIC
  // Administrators and staff can open any other stored file (production needs the customer files).
  if (isStaff) return PRIVATE

  if (top === 'orders') {
    const orderId = segs[1]
    if (!viewer || !orderId) return DENY
    const order = await prisma.printOrder.findUnique({ where: { id: orderId }, select: { userId: true } })
    return order?.userId === viewer.id ? PRIVATE : DENY
  }
  if (top === 'failure-photos' || top === 'zips') return DENY

  // Anything else is a per-user folder named after its owner.
  if (viewer && viewer.id === top) return PRIVATE
  if (segs.length >= 3 && PUBLIC_ASSET_FOLDERS.has(segs[1]) && await isPublicModelAsset(rel)) return PUBLIC
  if (viewer && await isOwnOrderItemFile(viewer.id, rel)) return PRIVATE
  return DENY
}

// Same rule for the model download endpoint: public/unlisted models, the owner, or staff.
export function canAccessModelFiles(model: { userId: string; visibility: string }, viewer: FileViewer) {
  if (PUBLIC_MODEL_VISIBILITIES.includes(model.visibility)) return true
  if (!viewer) return false
  return viewer.role === 'admin' || viewer.role === 'staff' || viewer.id === model.userId
}
