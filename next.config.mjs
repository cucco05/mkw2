// The currency the browser pages are built for (NEXT_PUBLIC_CURRENCY is written into the JavaScript at build time, USD when unset). Stamped into
// the build so that the server can refuse to take money when it is configured for another currency (lib/currency.ts, getCurrencyConfigProblem).
const SUPPORTED_CURRENCIES = ['USD', 'CAD', 'AUD', 'EUR']
const requestedCurrency = (process.env.NEXT_PUBLIC_CURRENCY || '').trim().toUpperCase()
const builtCurrency = SUPPORTED_CURRENCIES.includes(requestedCurrency) ? requestedCurrency : 'USD'

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_CURRENCY: builtCurrency,
  },
  outputFileTracingExcludes: {
    '*': ['./storage/**/*']
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb'
    }
  },
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost' },
      { protocol: 'http', hostname: '127.0.0.1' }
    ]
  }
}

export default nextConfig
