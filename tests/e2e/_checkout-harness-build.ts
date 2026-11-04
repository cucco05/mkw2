// Builds, for the browser, the harness of tests/e2e/_checkout-harness.tsx: the REAL components/checkout/HostedCheckout.tsx with the REAL React 19 (the development build, which runs components and
// effects twice in Strict Mode, or the production build). esbuild is already in the tree (tsx brings it): nothing new is installed.
// Three things are substituted, at build time, and nothing else:
//   * `next/link` -> tests/e2e/_next-link-shim.tsx (an anchor), because there is no Next router in a harness page;
//   * `window.location.assign` -> `__mwAssign` (tests/e2e/_checkout-harness.tsx), the browser's way to leave the page, which a spec has to be able to watch and to make fail;
//   * Node's `crypto` -> a module whose functions throw if they are ever called. It is reached only through lib/order-status-client.ts -> lib/checkout-status.ts -> lib/guest-order-access.ts (the
//     server's token functions), by an import of the order-id pattern; the site's own bundler gives the browser a polyfill, and nothing under test calls it.
// The "lost-answer" variant substitutes TWO more modules, both inert until the test arms them: lib/checkout-single-flight.ts with tests/e2e/_single-flight-fault-shim.ts (the real module plus a
// sendPurchase that can be told to lose its answer) and lib/checkout-client.ts with tests/e2e/_checkout-client-fault-shim.ts (the real module plus a cartItemsSignature that can be told to throw,
// which makes pay() fail before it has handed anything over). The specs that are about the real sendPurchase use the "real" variant.
import path from 'node:path'
import { build, type Plugin } from 'esbuild'

export type HarnessVariant = 'real' | 'lost-answer'
const cache = new Map<string, Promise<string>>()

export function buildCheckoutHarness(mode: 'development' | 'production', variant: HarnessVariant = 'real'): Promise<string> {
  const key = `${mode}/${variant}`
  const cached = cache.get(key)
  if (cached) return cached
  const root = process.cwd()
  const substitutions: Plugin = {
    name: 'checkout-harness-substitutions',
    setup(b) {
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: path.join(root, 'tests/e2e/_next-link-shim.tsx') }))
      b.onResolve({ filter: /^crypto$/ }, () => ({ path: 'crypto', namespace: 'harness-crypto' }))
      b.onLoad({ filter: /.*/, namespace: 'harness-crypto' }, () => ({
        loader: 'js',
        contents: "const no = () => { throw new Error('node:crypto is not available in the harness page: nothing under test calls it') }\n"
          + 'export const createHash = no\nexport const createHmac = no\nexport const timingSafeEqual = no\nexport default { createHash: no, createHmac: no, timingSafeEqual: no }\n',
      }))
      if (variant === 'lost-answer') {
        b.onResolve({ filter: /^@\/lib\/checkout-single-flight$/ }, () => ({ path: path.join(root, 'tests/e2e/_single-flight-fault-shim.ts') }))
        b.onResolve({ filter: /^@\/lib\/checkout-client$/ }, () => ({ path: path.join(root, 'tests/e2e/_checkout-client-fault-shim.ts') }))
      }
    },
  }
  const built = build({
    entryPoints: [path.join(root, 'tests/e2e/_checkout-harness.tsx')],
    tsconfig: path.join(root, 'tsconfig.json'),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    minify: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode), 'window.location.assign': '__mwAssign' },
    // the site's own code reads `process.env[name]` here and there; in the browser bundle of Next that is an empty object, and so it is here
    banner: { js: 'var process = { env: {} };' },
    plugins: [substitutions],
  }).then((result) => result.outputFiles[0].text)
  cache.set(key, built)
  return built
}
