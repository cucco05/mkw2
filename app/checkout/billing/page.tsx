import LegacyCheckout from '@/components/checkout/LegacyCheckout'
import { isLegacyCardCheckoutEnabled } from '@/lib/checkout-guards'

// The ways of paying that are not the hosted card checkout (administrators, organization quote requests). Behind the sign-in (proxy.ts).
// Read at request time: whether the old card path may take payments is a deployment setting, not something to freeze at build time.
export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Billing checkout',
  robots: { index: false, follow: false },
}

export default function BillingCheckoutPage() {
  return <LegacyCheckout cardEnabled={isLegacyCardCheckoutEnabled()} />
}
