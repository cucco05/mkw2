import CheckoutStatus from '@/components/checkout/CheckoutStatus'
import { viewerGuards } from '@/lib/viewer'
import { ORDER_ID_PATTERN } from '@/lib/checkout-status'
import { STATUS_PAGE_COPY } from '@/lib/checkout-copy'

// The page Stripe sends the customer back to (success_url = /checkout/success?order=<id>). Public in proxy.ts: reaching the PAGE shows and proves
// nothing. What it shows is asked from /api/checkout/status, which answers only the signed-in owner or the guest whose browser holds this order's
// access cookie. The page reads nothing else from the address (no session id, no status, no amount) and nothing about the order on the server side.
export const dynamic = 'force-dynamic'
export const metadata = {
  title: STATUS_PAGE_COPY.pageTitle,
  // an address with an order id must not travel to other sites or into search engines
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
}

export default async function CheckoutSuccessPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const raw = typeof query.order === 'string' ? query.order : ''
  const viewer = await viewerGuards.getViewer()
  const contact = (process.env['NEXT_PUBLIC_CONTACT_EMAIL'] || '').trim()
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <CheckoutStatus orderId={ORDER_ID_PATTERN.test(raw) ? raw : null} signedIn={Boolean(viewer)} contactEmail={contact || null} />
    </div>
  )
}
