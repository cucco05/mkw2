import HostedCheckout from '@/components/checkout/HostedCheckout'
import { prisma } from '@/lib/db'
import { viewerGuards } from '@/lib/viewer'

// Open to everybody, signed in or not (a guest pays without an account; proxy.ts lists this page as public). The page holds nothing
// private: the cart lives in the browser and every figure comes from /api/checkout/quote.
export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Riepilogo e pagamento',
  robots: { index: false, follow: false },
}

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const viewer = await viewerGuards.getViewer()
  // Administrators and organization members also have the billing page (invoice / quote request); everybody else never sees the link.
  const showBillingLink = viewer
    ? viewer.role === 'admin' || (await prisma.organizationMember.count({ where: { userId: viewer.id, status: 'active' } })) > 0
    : false
  return <HostedCheckout signedIn={Boolean(viewer)} canceled={query.canceled === '1'} showBillingLink={showBillingLink} />
}
