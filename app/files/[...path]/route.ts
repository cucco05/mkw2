import { NextRequest } from 'next/server'
export const dynamic = 'force-dynamic'
import { createReadStream } from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { getModelMimeType } from '@/lib/model-files'
import { storageRoot } from '@/lib/storage'
import { authorizeStorageFile, fileRouteGuards, normalizeStorageRelPath, resolveStorageFile } from '@/lib/file-access'

type FileRouteContext = { params: Promise<{ path: string[] }> }

const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' }

// Access is decided by lib/file-access.ts (default deny) before the disk is touched.
// Anonymous callers get 401 for anything that is not public; signed-in callers get 404, so the
// response never tells whether a file they may not read exists.
export async function GET(_req: NextRequest, { params }: FileRouteContext) {
  const routeParams = await params
  const rel = normalizeStorageRelPath(routeParams.path)
  if (!rel) return new Response('Not found', { status: 404, headers: NOSNIFF })

  const viewer = await fileRouteGuards.getViewer()
  const access = await authorizeStorageFile(rel, viewer)
  if (!access.allow) {
    return viewer
      ? new Response('Not found', { status: 404, headers: NOSNIFF })
      : new Response('Authentication required', { status: 401, headers: NOSNIFF })
  }

  const file = await resolveStorageFile(storageRoot(), rel)
  if (!file) return new Response('Not found', { status: 404, headers: NOSNIFF })

  const ext = path.extname(file.full).toLowerCase()
  const contentType = mimeFromExt(ext)
  const headers: Record<string, string> = {
    ...NOSNIFF,
    'Content-Type': contentType,
    'Content-Length': String(file.size),
    // Public display assets may be cached briefly; private files are never stored by browsers or proxies.
    'Cache-Control': access.scope === 'public' ? 'public, max-age=3600' : 'private, no-store',
  }
  if (access.scope === 'private') headers.Vary = 'Cookie'
  if (contentType === 'application/octet-stream') {
    headers['Content-Disposition'] = `attachment; filename="${path.basename(file.full).replace(/[^\w.\-]+/g, '_')}"`
  }
  return new Response(Readable.toWeb(createReadStream(file.full)) as unknown as BodyInit, { headers })
}

function mimeFromExt(ext: string) {
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.pdf': return 'application/pdf'
    default: return getModelMimeType(ext)
  }
}
