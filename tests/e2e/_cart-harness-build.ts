// Builds, for the browser, the harness of tests/e2e/_cart-harness.tsx: the REAL components/cart/CartProvider.tsx with the REAL React 19 (the development build, which is the one that
// runs components and updaters twice in Strict Mode, or the production build) in one script. esbuild is already in the tree (tsx brings it): nothing new is installed.
// Why a harness and not the site: the rules of S-10 are about what React does with an update that is queued while the scheduler is stopped, so the test must be able to stop
// the scheduler, mount the provider with and without Strict Mode, and look at every commit and every write - things a page of the site gives no handle for.
import path from 'node:path'
import { build } from 'esbuild'

const cache = new Map<string, Promise<string>>()

export function buildCartHarness(mode: 'development' | 'production'): Promise<string> {
  const cached = cache.get(mode)
  if (cached) return cached
  const root = process.cwd()
  const built = build({
    entryPoints: [path.join(root, 'tests/e2e/_cart-harness.tsx')],
    tsconfig: path.join(root, 'tsconfig.json'),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    minify: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    // the site's own code reads `process.env[name]` here and there (lib/cartPricing.ts); in the browser bundle of Next that is an empty object, and so it is here
    banner: { js: 'var process = { env: {} };' },
  }).then((result) => result.outputFiles[0].text)
  cache.set(mode, built)
  return built
}

// Installed BEFORE any script of the page: the scheduler of React takes its MessageChannel when it loads. With `freeze()` the messages it posts to itself are held, which is what a
// tab that is frozen, in the background or starved looks like to React: updates are queued, nothing renders, no effect runs. `release()` lets them through.
export const FROZEN_SCHEDULER_SCRIPT = `
(() => {
  const state = (window.__sched = { frozen: false, held: [], posted: 0 })
  state.freeze = () => { state.frozen = true }
  state.release = () => { state.frozen = false; const run = state.held.splice(0); for (const send of run) send() }
  const Native = window.MessageChannel
  window.MessageChannel = function MessageChannel() {
    const channel = new Native()
    const post = channel.port2.postMessage.bind(channel.port2)
    return { port1: channel.port1, port2: { postMessage(message) { state.posted++; if (state.frozen) state.held.push(() => post(message)); else post(message) } } }
  }
})()
`
