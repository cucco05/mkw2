export const UPLOAD_VISIBILITIES = ['public', 'unlisted', 'private'] as const

export type UploadVisibility = typeof UPLOAD_VISIBILITIES[number]

type UploadViewer = {
  isAdmin?: boolean | null
  role?: string | null
} | null | undefined

export function canChooseUploadVisibility(viewer: UploadViewer) {
  return Boolean(viewer?.isAdmin || viewer?.role === 'admin' || viewer?.role === 'staff')
}

// Privacy by default: every upload is private. Only shop staff/admin can ask for another value, and only
// for their own models (the models/API layer ignores `public`/`unlisted` on customer-owned models anyway,
// see lib/model-access.ts).
export function resolveUploadVisibility(value: unknown, canChoose: boolean): UploadVisibility {
  if (!canChoose) return 'private'
  return UPLOAD_VISIBILITIES.includes(value as UploadVisibility) ? value as UploadVisibility : 'private'
}
