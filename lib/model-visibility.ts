import type { Prisma } from '@prisma/client'
import { PUBLISHABLE_VISIBILITIES, publishedModelWhere } from '@/lib/model-access'

// Visibility filters for lists and checkout. The rule itself lives in lib/model-access.ts:
// only models owned by an admin/staff account can be shown to others; customer models are always private.
export const DISCOVERABLE_MODEL_VISIBILITY = 'public'
export const DIRECT_ORDERABLE_MODEL_VISIBILITIES = PUBLISHABLE_VISIBILITIES

export function isDirectOrderableVisibility(visibility: string | null | undefined) {
  return (DIRECT_ORDERABLE_MODEL_VISIBILITIES as readonly string[]).includes(String(visibility))
}

// Catalogue listing: published AND public (unlisted stays reachable by direct link only).
export function discoverVisibleModelWhere(): Prisma.ModelWhereInput {
  return { AND: [publishedModelWhere(), { visibility: DISCOVERABLE_MODEL_VISIBILITY }] }
}

export function checkoutVisibleModelWhere(
  ids: string[],
  userId?: string | null,
  hasElevatedModelAccess = false,
): Prisma.ModelWhereInput {
  if (hasElevatedModelAccess) return { id: { in: ids } }
  if (userId) {
    return { id: { in: ids }, OR: [publishedModelWhere(), { userId }] }
  }
  return { id: { in: ids }, ...publishedModelWhere() }
}

export function checkoutVisiblePartWhere(
  ids: string[],
  userId?: string | null,
  hasElevatedModelAccess = false,
): Prisma.ModelPartWhereInput {
  if (hasElevatedModelAccess) return { id: { in: ids } }
  if (userId) {
    return { id: { in: ids }, model: { OR: [publishedModelWhere(), { userId }] } }
  }
  return { id: { in: ids }, model: publishedModelWhere() }
}
