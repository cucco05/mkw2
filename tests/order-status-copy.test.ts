// Step 4.3 – the words of the return page: Italian, in one place, and they never claim a payment that the server has not verified.
import assert from 'node:assert/strict'
import test from 'node:test'
import { CHECKOUT_ACTIONS, CHECKOUT_STATE_COPY, STATUS_PAGE_COPY, formatOrderNumber, supportLine } from '../lib/checkout-copy'

const everyText = () => [
  ...Object.values(CHECKOUT_STATE_COPY).flatMap((copy) => [copy.title, copy.message, copy.hint ?? '']),
  ...Object.values(STATUS_PAGE_COPY), ...Object.values(CHECKOUT_ACTIONS), supportLine(null), supportLine('aiuto@example.test'),
]

test('the return page speaks Italian: no English word of the commonest kinds in any sentence', () => {
  for (const text of everyText()) assert.equal(/\b(the|please|your|order|payment|error|retry|loading|thank|paid|cart)\b/i.test(text), false, text)
})

test('only a payment the server has verified is called received: no other state, and no error, claims it', () => {
  // "se hai pagato…" (the neutral message for an order that is not ours) is a condition, not a claim
  const claims = /pagamento ricevuto|pagamento è stato (ricevuto|verificato)|(?<!se )hai pagato|pagato con successo|ordine confermato|grazie/i
  for (const state of ['pending', 'confirming', 'canceled', 'unknown'] as const) {
    const copy = CHECKOUT_STATE_COPY[state]
    assert.equal(claims.test(`${copy.title} ${copy.message} ${copy.hint ?? ''}`), false, state)
  }
  for (const key of ['loading', 'asking', 'waiting', 'gaveUp', 'errorTitle', 'errorMessage', 'errorRetrying', 'retry', 'goHome'] as const) {
    assert.equal(claims.test(STATUS_PAGE_COPY[key]), false, key)
  }
  assert.equal(claims.test(CHECKOUT_STATE_COPY.paid.title), true, 'the verified state does say it')
  assert.match(CHECKOUT_STATE_COPY.attention.title, /stiamo verificando/i, 'a payment that a person must look at says so')
})

test('a failure to check is never presented as a failed payment', () => {
  assert.doesNotMatch(STATUS_PAGE_COPY.errorMessage + STATUS_PAGE_COPY.errorTitle, /fallit|rifiutat|non riuscit[oa] il pagamento/i)
  assert.match(STATUS_PAGE_COPY.errorMessage, /non significa che il pagamento non sia andato a buon fine/i)
  assert.match(STATUS_PAGE_COPY.gaveUp, /registrato comunque/i)
})

test('the order number is MW- and five digits; the neutral message promises nothing about recovering a guest order', () => {
  assert.equal(formatOrderNumber(7), 'MW-00007')
  assert.equal(formatOrderNumber(123456), 'MW-123456')
  const neutral = `${CHECKOUT_STATE_COPY.unknown.message} ${supportLine('assistenza@example.test')}`
  assert.doesNotMatch(neutral, /registrati|crea un account|recuper/i)
  assert.match(neutral, /verificheremo la tua identità/i)
  assert.match(supportLine('  assistenza@example.test  '), /assistenza@example\.test/)
})
