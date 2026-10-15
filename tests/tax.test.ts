import assert from 'node:assert/strict'
import test from 'node:test'

import { computeTax, getTaxConfig, getTaxSalesBlocker } from '../lib/tax'
import { buildEnvChecks } from '../app/api/admin/env-check/route'

// Tax is provisional during development (taxCents = 0) but the module must already behave correctly,
// and a shop that is not configured must not be able to sell in production.

test('tax config: unset is NOT configured and charges nothing', () => {
  const config = getTaxConfig({})
  assert.equal(config.configured, false)
  assert.equal(config.mode, 'none')
  assert.deepEqual(computeTax(10_000, config), { taxCents: 0, addedCents: 0 })
})

test('tax config: "none" is an explicit, valid choice', () => {
  const config = getTaxConfig({ TAX_MODE: 'none' })
  assert.equal(config.configured, true)
  assert.deepEqual(computeTax(10_000, config), { taxCents: 0, addedCents: 0 })
})

test('tax config: invalid values are rejected, never guessed', () => {
  for (const env of [
    { TAX_MODE: 'vat' },
    { TAX_MODE: 'inclusive' },
    { TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '0' },
    { TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '-5' },
    { TAX_MODE: 'exclusive', TAX_RATE_PERCENT: 'abc' },
    { TAX_MODE: 'inclusive', TAX_RATE_PERCENT: '101' },
  ]) {
    const config = getTaxConfig(env)
    assert.equal(config.configured, false, JSON.stringify(env))
    assert.ok(config.problem, JSON.stringify(env))
    assert.deepEqual(computeTax(10_000, config), { taxCents: 0, addedCents: 0 })
  }
})

test('tax: exclusive adds the tax on top of the amount', () => {
  const config = getTaxConfig({ TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '22' })
  assert.equal(config.configured, true)
  assert.deepEqual(computeTax(10_000, config), { taxCents: 2_200, addedCents: 2_200 })
  assert.deepEqual(computeTax(1_999, config), { taxCents: 440, addedCents: 440 }) // 439.78 -> 440
})

test('tax: inclusive reports the tax contained in the amount and does not change the total', () => {
  const config = getTaxConfig({ TAX_MODE: 'inclusive', TAX_RATE_PERCENT: '22' })
  assert.deepEqual(computeTax(12_200, config), { taxCents: 2_200, addedCents: 0 })
  assert.deepEqual(computeTax(1_000, config), { taxCents: 180, addedCents: 0 }) // 1000 * 22 / 122 = 180.3
})

test('tax: edge amounts', () => {
  const config = getTaxConfig({ TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '22' })
  assert.deepEqual(computeTax(0, config), { taxCents: 0, addedCents: 0 })
  assert.deepEqual(computeTax(-500, config), { taxCents: 0, addedCents: 0 })
})

test('sales blocker: only production without a valid tax configuration is blocked', () => {
  assert.equal(getTaxSalesBlocker({ NODE_ENV: 'development' }), null)
  assert.equal(getTaxSalesBlocker({ NODE_ENV: 'test' }), null)
  assert.equal(getTaxSalesBlocker({}), null)
  assert.match(getTaxSalesBlocker({ NODE_ENV: 'production' }) || '', /Tax configuration is missing or invalid/)
  assert.match(getTaxSalesBlocker({ NODE_ENV: 'production', TAX_MODE: 'inclusive' }) || '', /TAX_RATE_PERCENT/)
  assert.equal(getTaxSalesBlocker({ NODE_ENV: 'production', TAX_MODE: 'none' }), null)
  assert.equal(getTaxSalesBlocker({ NODE_ENV: 'production', TAX_MODE: 'inclusive', TAX_RATE_PERCENT: '22' }), null)
})

test('admin environment check: tax configuration is required in production, optional elsewhere', () => {
  const base = { DATABASE_URL: 'postgresql://makerworks.local/test', JWT_SECRET: 'a-valid-test-jwt-secret-with-32-chars' }
  const production = buildEnvChecks({ ...base, NODE_ENV: 'production' })
  const tax = production.find((check) => check.key === 'TAX_MODE')
  assert.ok(tax)
  assert.equal(tax.required, true)
  assert.equal(tax.ok, false)

  const configured = buildEnvChecks({ ...base, NODE_ENV: 'production', TAX_MODE: 'none' }).find((check) => check.key === 'TAX_MODE')
  assert.equal(configured?.ok, true)

  assert.equal(buildEnvChecks(base).some((check) => check.key === 'TAX_MODE'), false)
  const dev = buildEnvChecks({ ...base, TAX_MODE: 'inclusive' }).find((check) => check.key === 'TAX_MODE')
  assert.equal(dev?.required, false)
  assert.equal(dev?.ok, false)
})
