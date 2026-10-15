// The person making the current request, reduced to what authorization needs.
import { getUserIdFromCookie } from '@/lib/auth'
import { prisma } from '@/lib/db'

export type Viewer = { id: string; role: 'admin' | 'staff' | 'customer' } | null

export const viewerGuards = {
  // Overridable in tests (route handlers cannot read cookies outside a request).
  async getViewer(): Promise<Viewer> {
    const userId = await getUserIdFromCookie()
    if (!userId) return null
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, isAdmin: true, role: true } })
    if (!user) return null
    const role = user.isAdmin || user.role === 'admin' ? 'admin' : user.role === 'staff' ? 'staff' : 'customer'
    return { id: user.id, role }
  },
}

export function isStaffViewer(viewer: Viewer) {
  return viewer?.role === 'admin' || viewer?.role === 'staff'
}

export function isAdminViewer(viewer: Viewer) {
  return viewer?.role === 'admin'
}
