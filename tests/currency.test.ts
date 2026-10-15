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
