import assert from 'node:assert/strict'
import test from 'node:test'

import { formatCurrency, getCurrency, getCurrencySymbol, isSupportedCurrency, toCents } from '../lib/currency'

const plain = (text: string) => text.replace(/ /g, ' ')

function withCurrency<T>(value: string | undefined, fn: () => T): T {
  const saved = { a: process.env.CURRENCY, b: process.env.NEXT_PUBLIC_CURRENCY }
  delete process.env.NEXT_PUBLIC_CURRENCY
  if (value === undefined) delete process.env.CURRENCY
  else process.env.CURRENCY = value
  try {
    return fn()
  } finally {
    if (saved.a === undefined) delete process.env.CURRENCY; else process.env.CURRENCY = saved.a
    if (saved.b === undefined) delete process.env.NEXT_PUBLIC_CURRENCY; else process.env.NEXT_PUBLIC_CURRENCY = saved.b
  }
}

test('EUR is a supported currency', () => {
  assert.equal(isSupportedCurrency('EUR'), true)
  assert.equal(isSupportedCurrency('eur'), true)
  assert.equal(isSupportedCurrency('GBP'), false)
  assert.equal(isSupportedCurrency(undefined), false)
  assert.equal(withCurrency('EUR', () => getCurrency()), 'EUR')
  assert.equal(withCurrency('eur', () => getCurrency()), 'EUR')
})

test('the default does not change by itself: unset or unknown stays USD (nothing is reinterpreted silently)', () => {
  assert.equal(withCurrency(undefined, () => getCurrency()), 'USD')
  assert.equal(withCurrency('GBP', () => getCurrency()), 'USD')
})

test('euro amounts are formatted for Italy, other currencies as before', () => {
  assert.equal(plain(formatCurrency(12345.6, 'EUR')), '12.345,60 €')
  assert.equal(plain(formatCurrency(12.3, 'EUR')), '12,30 €')
  assert.equal(formatCurrency(1234.5, 'USD'), '$1,234.50')
  assert.equal(getCurrencySymbol('EUR'), '€')
  assert.equal(getCurrencySymbol('USD'), '$')
})

test('a stored order keeps its own currency even when the shop is set to EUR (no conversion)', () => {
  withCurrency('EUR', () => {
    assert.equal(formatCurrency(15, 'USD'), '$15.00')
    assert.equal(formatCurrency(20, 'CAD'), withCurrency('CAD', () => formatCurrency(20)))
  })
})

test('toCents rounds once and never goes negative', () => {
  assert.equal(toCents(12.34), 1234)
  assert.equal(toCents(0.1 + 0.2), 30)
  assert.equal(toCents(2.675), 268)
  assert.equal(toCents(-3), 0)
  assert.equal(toCents(0), 0)
})

// ---- step 4.2-ter (A3): the pages and the server must agree on the currency ------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getCurrencyConfigProblem } from '../lib/currency'
import { getCheckoutBlocker } from '../lib/checkout-guards'
import { buildEnvChecks } from '../app/api/admin/env-check/route'

test('currency configuration: a consistent setup is fine, in production it must be chosen on purpose', () => {
  assert.equal(getCurrencyConfigProblem({ CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', NODE_ENV: 'production' }, 'EUR'), null)
  assert.equal(getCurrencyConfigProblem({ CURRENCY: 'eur', NEXT_PUBLIC_CURRENCY: 'EUR' }, 'EUR'), null, 'case does not matter')
  assert.equal(getCurrencyConfigProblem({ CURRENCY: 'EUR' }, 'EUR'), null, 'only the server variable set: still consistent with a EUR build')
  assert.equal(getCurrencyConfigProblem({}, undefined), null, 'development and tests: nothing configured is the old default, not a problem')
  assert.equal(getCurrencyConfigProblem({ NODE_ENV: 'production' }, 'USD')?.code, 'CURRENCY_NOT_CONFIGURED', 'production never falls back to USD silently')
})

test('currency configuration: a typo, two different values, or a build for another currency stop card payments', () => {
  assert.equal(getCurrencyConfigProblem({ CURRENCY: 'EURO' }, 'EUR')?.code, 'CURRENCY_INVALID')
  assert.equal(getCurrencyConfigProblem({ NEXT_PUBLIC_CURRENCY: 'GBP' }, undefined)?.code, 'CURRENCY_INVALID')
  assert.equal(getCurrencyConfigProblem({ CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'USD' }, 'EUR')?.code, 'CURRENCY_MISMATCH')
  // the Docker bug: the image was built without the variable (pages built for USD) and started with CURRENCY=EUR
  const dockerBug = getCurrencyConfigProblem({ CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', NODE_ENV: 'production' }, 'USD')
  assert.equal(dockerBug?.code, 'CURRENCY_MISMATCH')
  assert.match(dockerBug!.message, /rebuild/i)
  assert.equal(getCurrencyConfigProblem({ CURRENCY: 'USD', NEXT_PUBLIC_CURRENCY: 'USD', NODE_ENV: 'production' }, 'EUR')?.code, 'CURRENCY_MISMATCH', 'and the other way round')
})

test('the checkout refuses to take money while the currency configuration is inconsistent, and says so to the admin', () => {
  const base = { NODE_ENV: 'production', HOSTED_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', TAX_MODE: 'none', BASE_URL: 'https://shop.example.test' }
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...base, CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR' } }), null)
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...base } })?.code, 'CURRENCY_NOT_CONFIGURED')
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...base, CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'USD' } })?.code, 'CURRENCY_MISMATCH')
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...base, CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR' } })?.status, undefined)

  const checks = buildEnvChecks({ DATABASE_URL: 'x', JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'production', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'USD' } as any)
  const currency = checks.find((check) => check.key === 'CURRENCY')
  assert.ok(currency, 'the admin environment check lists the currency')
  assert.equal(currency!.required, true)
  assert.equal(currency!.ok, false)
  const good = buildEnvChecks({ NODE_ENV: 'production', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR' } as any).find((check) => check.key === 'CURRENCY')
  assert.equal(good!.ok, true)
})

test('the build is stamped with the currency the pages are built for (USD when the variable is missing: the Docker bug becomes visible)', async () => {
  const url = pathToFileURL(path.join(process.cwd(), 'next.config.mjs')).href
  const saved = process.env.NEXT_PUBLIC_CURRENCY
  try {
    process.env.NEXT_PUBLIC_CURRENCY = 'EUR'
    assert.equal((await import(`${url}?eur`)).default.env.NEXT_PUBLIC_BUILD_CURRENCY, 'EUR')
    delete process.env.NEXT_PUBLIC_CURRENCY
    assert.equal((await import(`${url}?none`)).default.env.NEXT_PUBLIC_BUILD_CURRENCY, 'USD')
    process.env.NEXT_PUBLIC_CURRENCY = 'euro'
    assert.equal((await import(`${url}?typo`)).default.env.NEXT_PUBLIC_BUILD_CURRENCY, 'USD')
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_CURRENCY; else process.env.NEXT_PUBLIC_CURRENCY = saved
  }
})

test('Docker: the image is BUILT with the currency (build arguments) and the compose file passes the same value to the build and to the container', () => {
  const dockerfile = fs.readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8')
  const builder = dockerfile.slice(dockerfile.indexOf('AS builder'), dockerfile.indexOf('AS runner'))
  assert.match(builder, /ARG NEXT_PUBLIC_CURRENCY/)
  assert.match(builder, /ARG CURRENCY/)
  assert.match(builder, /ENV NEXT_PUBLIC_CURRENCY=/)
  assert.ok(builder.indexOf('ENV NEXT_PUBLIC_CURRENCY=') < builder.indexOf('npm run build'), 'the variable is set before the build runs')

  const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8')
  const web = compose.slice(compose.indexOf('\n  web:'), compose.indexOf('\n  processing-worker:'))
  const args = web.slice(web.indexOf('args:'), web.indexOf('restart:'))
  assert.match(args, /NEXT_PUBLIC_CURRENCY: \$\{NEXT_PUBLIC_CURRENCY:-\$\{CURRENCY:-EUR\}\}/)
  assert.match(args, /CURRENCY: \$\{CURRENCY:-EUR\}/)
  const env = web.slice(web.indexOf('environment:'))
  assert.match(env, /NEXT_PUBLIC_CURRENCY: \$\{NEXT_PUBLIC_CURRENCY:-\$\{CURRENCY:-EUR\}\}/)
  assert.match(env, /\n\s+CURRENCY: \$\{CURRENCY:-EUR\}/)

  const example = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8')
  assert.match(example, /^NEXT_PUBLIC_CURRENCY="EUR"$/m)
  assert.match(example, /^CURRENCY="EUR"$/m)
})
