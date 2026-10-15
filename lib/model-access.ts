// Single authorization policy for 3D models (used by the API routes, the pages and the file server).
//
// This is a made-to-order print service, not a model marketplace:
//   * A customer's model is PRIVATE: only its owner and the shop staff can see it, whatever the stored
//     `visibility` says. Rows that were saved as "public"/"unlisted" before this policy existed are therefore
//     already protected, with no data change required.
//   * Only models owned by an admin/staff account can be shown to other people (public or unlisted).
//   * A customer model could only ever be published with the owner's explicit consent. No consent flow exists
//     (the public catalogue is being removed), so nobody — administrators included — can publish one.
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { isStaffViewer, type Viewer } from '@/lib/viewer'

export const PUBLISHABLE_VISIBILITIES = ['public', 'unlisted'] as const

type OwnerAccount = { isAdmin?: boolean | null; role?: string | null } | null | undefined
export type ModelAccessRow = { userId: string; visibility: string | null; user?: OwnerAccount }

// Accounts that belong to the shop (their models are the shop's own showcase/products).
export function isShopAccount(user: OwnerAccount) {
  return Boolean(user && (user.isAdmin || user.role === 'admin' || user.role === 'staff'))
}

// Can this model be shown to people other than its owner and the staff?
export function isModelPublished(row: ModelAccessRow) {
  return (PUBLISHABLE_VISIBILITIES as readonly string[]).includes(String(row.visibility)) && isShopAccount(row.user)
}

export function canViewModel(row: ModelAccessRow, viewer: Viewer) {
  if (isModelPublished(row)) return true
  if (!viewer) return false
  return isStaffViewer(viewer) || viewer.id === row.userId
}

// Edit / replace files / delete: the owner and administrators.
export function canManageModel(row: Pick<ModelAccessRow, 'userId'>, viewer: Viewer) {
  if (!viewer) return false
  return viewer.role === 'admin' || viewer.id === row.userId
}

// Only a shop account can publish. (A customer model would need the owner's explicit consent.)
export function canPublishModelFor(owner: OwnerAccount) {
  return isShopAccount(owner)
}

// ---- Prisma filters (use these instead of ad-hoc `visibility: 'public'` conditions) -----------------
export function publishedModelWhere(): Prisma.ModelWhereInput {
  return {
    visibility: { in: [...PUBLISHABLE_VISIBILITIES] },
    user: { OR: [{ isAdmin: true }, { role: { in: ['admin', 'staff'] } }] },
  }
}

// Store products may point to a base model; hide products whose base model is not published.
export function publishedProductWhere(): Prisma.ProductTemplateWhereInput {
  return { OR: [{ baseModelId: null }, { baseModel: publishedModelWhere() }] }
}

export function viewableModelWhere(viewer: Viewer): Prisma.ModelWhereInput {
  if (isStaffViewer(viewer)) return {}
  if (!viewer) return publishedModelWhere()
  return { OR: [publishedModelWhere(), { userId: viewer.id }] }
}

// ---- Single-record lookup ---------------------------------------------------------------------------
export async function loadModelAccessRow(modelId: string): Promise<ModelAccessRow | null> {
  return prisma.model.findUnique({
    where: { id: modelId },
    select: { userId: true, visibility: true, user: { select: { isAdmin: true, role: true } } },
  })
}

// Returns the row only when the viewer may see the model. A missing model and a forbidden one are
// indistinguishable to the caller (both null) so model ids cannot be probed.
export async function getViewableModelRow(modelId: string, viewer: Viewer): Promise<ModelAccessRow | null> {
  const row = await loadModelAccessRow(modelId)
  return row && canViewModel(row, viewer) ? row : null
}
