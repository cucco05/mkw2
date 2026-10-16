export const dynamic = 'force-dynamic'

import { viewerGuards } from '@/lib/viewer'
import { isWaiverAdmin, listWaiverOverview } from '@/lib/minimum-waivers'
import PriceWaiversManager from '@/components/admin/PriceWaiversManager'

export default async function AdminPriceWaiversPage() {
  const viewer = await viewerGuards.getViewer()
  const allowed = viewer?.role === 'admin' && isWaiverAdmin(viewer.id)
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Minimum price waivers</h1>
        <p className="mt-1 text-sm text-slate-400">
          The shop sells no unit under its minimum price. A waiver lets ONE model or ONE ready-made product be sold for less, on purpose, with a written reason.
          It changes only the price of future carts: orders already made keep theirs, and a waiver never marks anything as paid or authorises production.
        </p>
      </div>
      {allowed ? (
        <PriceWaiversManager initial={JSON.parse(JSON.stringify(await listWaiverOverview()))} />
      ) : (
        <p role="alert" className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Only administrators allowed to manage price waivers can see and change them.
        </p>
      )}
    </div>
  )
}
