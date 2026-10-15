import { viewerGuards } from '@/lib/viewer'

export type ApiRole = 'admin' | 'staff' | 'customer'

export async function requireRole(allowedRoles: ApiRole[]): Promise<string> {
  // Same role rules as before (isAdmin / role admin => admin), resolved by the shared viewer function.
  const viewer = await viewerGuards.getViewer()
  if (!viewer) throw Object.assign(new Error('Unauthorized'), { status: 401 })
  if (!allowedRoles.includes(viewer.role)) {
    throw Object.assign(new Error('Forbidden'), { status: 403 })
  }
  return viewer.id
}

export async function requireAdmin(): Promise<string> {
  return requireRole(['admin', 'staff'])
}

export const adminRouteGuards = {
  requireAdmin,
}
