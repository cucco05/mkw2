// Stands for `next/link` in the browser harness of tests/e2e/checkout-faults.responsive.spec.ts (tests/e2e/_checkout-harness-build.ts substitutes it at build time and nowhere else): a link is an
// anchor. Nothing else of Next's router is used by the components under test, so nothing else is replaced.
import React from 'react'

export default function Link({ href, children, prefetch: _prefetch, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) {
  return <a href={href} {...rest}>{children}</a>
}
