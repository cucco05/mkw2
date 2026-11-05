// R1-2 (S-02, S-06) – what the customer is TOLD about money, and when the page may say it.
//
// The rule: a sentence says only what the code can show at the moment it is shown.
//   * a payment REQUEST that went out and has no usable answer is never "nothing was charged" (the server may have made the order and the page since);
//   * a page the customer comes BACK to (the "back" link of the payment page, a closed order) never denies a charge and never says "try again whenever you like": the address that says
//     "cancelled" is not proof of anything, and a payment page left open can still be paid;
//   * what the shop's records show is said as what the shop's RECORDS show ("nei nostri registri" / "recorded"), never as what happened to the card or the account;
//   * nothing invites to start again, to create a new key, or to repeat the payment at once;
//   * Italian and English say the same things.
// A sentence that denies a charge on a flow that can not charge anybody (a quote, a request for a manual quote) is allowed - it is on the list below, by name. A NEW one is not: this test
// finds every sentence of the customer-facing files that talks about charges and fails if it is not on the list.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { CHECKOUT_STATE_COPY, HOSTED_CHECKOUT_COPY, PENDING_PAYMENT_COPY, PENDING_PAYMENT_COPY_EN, STATUS_PAGE_COPY, failureMessage, supportLineCheck } from '../lib/checkout-copy'
import type { CheckoutFailure } from '../lib/checkout-client'
import { classifySessionFailure } from '../lib/checkout-client'
import { CUSTOMER_ORDER_COPY } from '../lib/customer-order-labels'

const money = (cents: number) => `${(cents / 100).toFixed(2)} €`
const failure = (kind: CheckoutFailure['kind'], extra: Partial<CheckoutFailure> = {}): CheckoutFailure => ({ kind, code: kind.toUpperCase(), status: 0, retry: false, ...extra })

// ---- 1. every sentence about charges in the customer-facing files is on the list ---------------------------------------------------------------------------
const CLAIM = /addebit|non è stato (pagat|completat)|nothing (has been|was) charged|nothing is charged|no charge|nessun (costo|pagamento)|gratuit|no payment is recorded|senza alcun|non risulta|risulta/i
// [file, a piece of the sentence, class, why it is allowed]
//   Q  a flow that can not charge anybody (a quote, a request for a manual quote)       P  a statement of policy / of the delivery    E1 what THIS request did, after a definitive refusal
//   S  what the shop's records show, with the words that say so                         E0 about this page's own act, before any request
const REGISTRY: Array<[string, string, string]> = [
  ['lib/checkout-copy.ts', 'Gratuito', 'P'],
  ['lib/checkout-copy.ts', 'Ritiro (gratuito)', 'P'],
  ['lib/checkout-copy.ts', 'ti evitano un doppio addebito', 'E0'],
  ['lib/checkout-copy.ts', 'non addebitarti due volte', 'E0'],
  ['lib/checkout-copy.ts', 'Non riusciamo a collegarci: controlla la connessione e riprova. Non è stato addebitato nulla.', 'Q'],
  ['lib/checkout-copy.ts', 'Il servizio di pagamento non risponde in questo momento. Non è stato addebitato nulla', 'Q'],
  ['lib/checkout-copy.ts', 'Qualcosa non ha funzionato. Non è stato addebitato nulla: riprova.', 'Q'],
  ['lib/checkout-copy.ts', 'Questa richiesta non ha avviato nessun pagamento: puoi chiederci un preventivo manuale', 'E1'],
  ['lib/checkout-copy.ts', 'questa richiesta non ha avviato nessun pagamento.', 'E1'],
  ['lib/checkout-copy.ts', 'Questa richiesta di pagamento risulta già collegata a un acquisto', 'E1'],
  ['lib/checkout-copy.ts', 'Questa richiesta non ha avviato nessun nuovo pagamento', 'E1'],
  ['lib/checkout-copy.ts', 'Il pagamento di questo ordine non risulta ancora completato', 'S'],
  ['lib/checkout-copy.ts', 'nei nostri registri non risulta pagato', 'S'],
  ['lib/checkout-copy.ts', 'Nothing has been charged: you can ask us for a manual quote', 'Q'],
  ['lib/checkout-copy.ts', 'Nothing is charged now', 'Q'],
  ['lib/checkout-copy.ts', 'Nothing has been charged.', 'Q'],
  ['lib/checkout-copy.ts', 'Ora non viene addebitato nulla', 'Q'],
  ['lib/checkout-copy.ts', 'Non è stato addebitato nulla.', 'Q'],
  ['lib/checkout-copy.ts', 'da questa pagina non è partita nessuna richiesta di pagamento', 'E0'],
  ['lib/customer-order-labels.ts', 'Nothing is charged and nothing is printed until you accept it', 'P'],
  ['lib/customer-order-labels.ts', 'No payment is recorded for it', 'S'],
  ['app/customer/orders/[orderId]/page.tsx', 'nothing is charged and nothing is printed until you accept it', 'P'],
  ['components/orders/RequestReprintButton.tsx', 'Nothing is charged until you accept it', 'P'],
]
const FILES = ['lib/checkout-copy.ts', 'lib/customer-order-labels.ts', 'app/customer/orders/[orderId]/page.tsx', 'components/orders/RequestReprintButton.tsx']
const walk = (dir: string, out: string[]) => {
  for (const item of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
    const relative = path.join(dir, item.name)
    if (item.isDirectory()) walk(relative, out)
    else if (/\.tsx?$/.test(item.name)) out.push(relative.split(path.sep).join('/'))
  }
}
const customerFiles = (() => { const found: string[] = []; walk('components/checkout', found); walk('components/cart', found); return [...FILES, ...found] })()
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
// the text of every string literal ('...', "...", `...`) and, in a .tsx file, of every piece of text between two tags
const literals = (text: string): string[] => {
  const stripped = code(text)
  const quoted = [...stripped.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\'/g, '\'').replace(/\\n/g, '\n'))
  const jsx = [...stripped.matchAll(/>\s*([^<>{}\n][^<>{}]*?)\s*</g)].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter((value) => value.length > 3)
  return [...quoted, ...jsx]
}

test('S-02 R1: every sentence that talks about charges, in the files the customer reads, is on the list - a new one fails until somebody decides what class it is', () => {
  const unregistered: string[] = []
  for (const file of customerFiles) {
    for (const sentence of literals(readFileSync(path.join(process.cwd(), file), 'utf8'))) {
      if (!CLAIM.test(sentence)) continue
      if (!REGISTRY.some(([where, piece]) => where === file && sentence.includes(piece))) unregistered.push(`${file}: ${sentence.slice(0, 120)}`)
    }
  }
  assert.deepEqual(unregistered, [])
})

test('S-02 R2: every entry of the list is still somewhere (a sentence that was removed leaves no ghost on the list)', () => {
  for (const [file, piece] of REGISTRY) {
    const found = literals(readFileSync(path.join(process.cwd(), file), 'utf8')).some((sentence) => sentence.includes(piece))
    assert.equal(found, true, `${file}: "${piece}" is not there any more`)
  }
})

test('S-02 R3: what the shop\'s records show is said as "what the shop\'s records show" - a sentence of class S has those words', () => {
  for (const [file, piece, kind] of REGISTRY.filter((entry) => entry[2] === 'S')) {
    const sentence = literals(readFileSync(path.join(process.cwd(), file), 'utf8')).find((candidate) => candidate.includes(piece))!
    // the one that talks about the order not being complete yet is a statement about a state the server reads, with its own hint; the others carry the words
    if (piece.startsWith('Il pagamento di questo ordine non risulta ancora completato')) continue
    assert.match(sentence, /nei nostri registri|recorded/, `${file}: ${kind}`)
  }
})

// ---- 2. the sentences of the return paths ---------------------------------------------------------------------------------------------------------------------
const returnSentences: Array<[string, string]> = [
  ['canceledNotice', HOSTED_CHECKOUT_COPY.canceledNotice],
  ['stripeRedirectFailed', HOSTED_CHECKOUT_COPY.stripeRedirectFailed],
  ['canceled.title', CHECKOUT_STATE_COPY.canceled.title],
  ['canceled.message', CHECKOUT_STATE_COPY.canceled.message],
  ['canceled.hint', CHECKOUT_STATE_COPY.canceled.hint ?? ''],
  ['closed_unpaid', CUSTOMER_ORDER_COPY.closed_unpaid.message],
  ['outcome_unknown', failureMessage(failure('outcome_unknown'), money)],
  ['purchase_not_started', failureMessage(failure('purchase_not_started'), money)],
  ['payment_page_unconfirmed', failureMessage(failure('payment_page_unconfirmed'), money)],
  ['purchase_key_in_use', failureMessage(failure('purchase_key_in_use', { supportCode: '3F9A2-C71B0' }), money)],
  ['payment_in_progress', failureMessage(failure('payment_in_progress', { orderId: 'clorderAAAAAAAAAAAAAAAA' }), money)],
  ['not_payable', failureMessage(failure('not_payable'), money)],
  ...Object.entries(PENDING_PAYMENT_COPY).filter(([, value]) => typeof value === 'string').map(([key, value]) => [`PENDING_PAYMENT_COPY.${key}`, value as string] as [string, string]),
  ...Object.entries(PENDING_PAYMENT_COPY_EN).filter(([, value]) => typeof value === 'string').map(([key, value]) => [`PENDING_PAYMENT_COPY_EN.${key}`, value as string] as [string, string]),
  ['cartEmptied', STATUS_PAGE_COPY.cartEmptied],
  ['cartLeft', STATUS_PAGE_COPY.cartLeft],
  ['cartPending', STATUS_PAGE_COPY.cartPending],
  ['cartUnlinked', STATUS_PAGE_COPY.cartUnlinked],
]

test('S-06 R4: no sentence of a return path denies a charge, invites to try again whenever, to start over, to make a new key, or says an unconfirmed thing is confirmed', () => {
  const forbidden = /addebit|charged|quando vuoi|ricominci|riprova (quando|subito)|order again|nuov[ao] chiave|new key|senza alcun|nothing was|nulla è stato (pagat|addebit)/i
  for (const [label, sentence] of returnSentences) {
    assert.ok(sentence.length > 0, label)
    assert.equal(forbidden.test(sentence), false, `${label}: ${sentence}`)
  }
})

test('S-06 R5: when a return path talks about what the shop\'s records show, it says "nei nostri registri" / "recorded"', () => {
  for (const [label, sentence] of returnSentences) {
    if (/non risulta|no payment is|is recorded|risulta pagat/i.test(sentence)) assert.match(sentence, /nei nostri registri|recorded/, label)
  }
})

test('S-06 R6: the return notice says it is a return, points to the order and to the shop, and is not an invitation', () => {
  const notice = HOSTED_CHECKOUT_COPY.canceledNotice
  assert.match(notice, /Sei tornato dalla pagina di pagamento/)
  assert.match(notice, /prima di pagare di nuovo/)
  assert.match(notice, /Il carrello è rimasto com'è/)
  assert.match(HOSTED_CHECKOUT_COPY.checkOrderStatus, /Controlla lo stato dell'ordine/)
  assert.match(supportLineCheck('aiuto@example.test'), /aiuto@example\.test/)
  assert.match(supportLineCheck(null), /l'assistenza del negozio/)
  assert.match(supportLineCheck(''), /l'assistenza del negozio/)
  assert.match(supportLineCheck('a@b.test'), /verificheremo la tua identità prima di darti qualsiasi informazione/)
})

test('S-06 R7: a closed order is closed in the records - it does not say the payment page can no longer be paid, and it asks nobody to repeat a payment', () => {
  assert.equal(CHECKOUT_STATE_COPY.canceled.title, 'Ordine chiuso')
  assert.match(CHECKOUT_STATE_COPY.canceled.message, /nei nostri registri non risulta pagato/)
  assert.match(CHECKOUT_STATE_COPY.canceled.message, /non ripeterlo/)
  assert.match(CUSTOMER_ORDER_COPY.closed_unpaid.message, /No payment is recorded for it/)
  assert.match(CUSTOMER_ORDER_COPY.closed_unpaid.message, /do not pay again/)
})

test('S-02/S-06 R8: a payment request that went out and has no answer is told apart from one that did not go out - and neither says "nothing was charged"', () => {
  const unknown = failureMessage(failure('outcome_unknown'), money)
  const notStarted = failureMessage(failure('purchase_not_started'), money)
  assert.match(unknown, /non riusciamo a verificare|non può sapere/i)
  assert.match(unknown, /controlla l'ordine/i)
  assert.ok(unknown.indexOf('controlla l\'ordine') < unknown.search(/un altro pagamento|riprovare/), 'it says "look at the order" BEFORE any word about another payment')
  assert.match(unknown, /evita di modificare il carrello/)
  assert.match(notStarted, /non è stato inviato nulla/)
  assert.match(notStarted, /il carrello è rimasto com'è/i)
  assert.notEqual(unknown, notStarted)
  const redirect = HOSTED_CHECKOUT_COPY.stripeRedirectFailed
  assert.match(redirect, /non possiamo sapere/)
  assert.ok(redirect.indexOf('controlla l\'ordine') < redirect.search(/riprovare/), 'and so does the sentence for a payment page that did not open')
})

test('S-02 R9: the payment request never ends in a kind whose sentence denies a charge - network, temporary and unknown become `outcome_unknown`; a refusal keeps its kind', () => {
  const cases: Array<[number, unknown]> = [[0, null], [500, {}], [502, null], [503, { code: 'PAYMENT_PROVIDER_UNAVAILABLE' }], [500, { code: 'CHECKOUT_FAILED' }], [418, { code: 'SOMETHING_NEW' }], [404, null], [200, null], [504, { code: 'TEMPORARY_ERROR' }]]
  for (const [status, body] of cases) assert.equal(classifySessionFailure(status, body).kind, 'outcome_unknown', `${status} ${JSON.stringify(body)}`)
  assert.equal(classifySessionFailure(409, { code: 'PRICE_CHANGED' }).kind, 'price_changed')
  assert.equal(classifySessionFailure(429, { code: 'RATE_LIMITED' }).kind, 'busy')
  assert.equal(classifySessionFailure(409, { code: 'PURCHASE_KEY_IN_USE' }).kind, 'purchase_key_in_use')
  assert.equal(classifySessionFailure(409, { code: 'CHECKOUT_KEY_CONFLICT' }).kind, 'conflict')
  assert.equal(classifySessionFailure(503, { code: 'CHECKOUT_DISABLED' }).kind, 'disabled')
  assert.equal(classifySessionFailure(500, {}).retry, false, 'and nothing is repeated by itself')
})

// ---- 3. the notes after a verified payment -----------------------------------------------------------------------------------------------------------------------
test('S-08/S-09 R10: the notes after a verified payment are four, they are told apart, none invites to pay again, and the page never says the cart was emptied in the sentence about the payment', () => {
  const it = PENDING_PAYMENT_COPY
  const en = PENDING_PAYMENT_COPY_EN
  for (const copy of [it, en]) {
    const notes = [copy.cartEmptiedNote, copy.cartKeptNote, copy.cartPendingNote, copy.cartUnlinkedNote]
    assert.equal(new Set(notes).size, 4, 'four different sentences')
    assert.doesNotMatch(copy.paidMessage, /svuotat|emptied/i, 'the sentence about the payment says nothing about the cart')
  }
  // "not emptied because of a new purchase" is for another purchase; "to be finished" and "could not be tied" are about THIS payment and say there is no need to pay again
  assert.match(it.cartPendingNote, /non serve pagare di nuovo/)
  assert.match(it.cartUnlinkedNote, /non serve pagare di nuovo/)
  assert.match(en.cartPendingNote, /do not need to pay again/)
  assert.match(en.cartUnlinkedNote, /do not need to pay again/)
  assert.match(it.cartUnlinkedNote, /non (lo )?abbiamo svuotato|non lo abbiamo svuotato/)
  assert.match(it.cartKeptNote, /nuovo acquisto/)
  assert.match(en.cartKeptNote, /new purchase/)
  for (const sentence of [it.cartPendingNote, it.cartUnlinkedNote, en.cartPendingNote, en.cartUnlinkedNote]) {
    assert.doesNotMatch(sentence, /paga ora|pay now|riprova a pagare|try paying|premi|press "?pay/i)
  }
  assert.deepEqual(Object.keys(it).sort(), Object.keys(en).sort(), 'the same sentences in both languages')
  for (const key of ['cartLeft', 'cartPending', 'cartUnlinked'] as const) assert.ok(STATUS_PAGE_COPY[key].length > 40, key)
  assert.equal(STATUS_PAGE_COPY.cartLeft, it.cartKeptNote)
  assert.equal(STATUS_PAGE_COPY.cartPending, it.cartPendingNote)
  assert.equal(STATUS_PAGE_COPY.cartUnlinked, it.cartUnlinkedNote)
  assert.equal(STATUS_PAGE_COPY.cartEmptied, it.cartEmptiedNote)
})

test('S-06 R11: every new sentence is plain text of a sensible length, in one language, and carries no identifier', () => {
  for (const [label, sentence] of returnSentences) {
    if (/title|Title|label|checkStatus|recheck|order/i.test(label) && sentence.length < 60) continue
    assert.ok(sentence.length >= 20 && sentence.length <= 560, `${label}: ${sentence.length} characters`)
    assert.doesNotMatch(sentence, /clorder|cs_[a-z]+_|pi_[A-Za-z0-9]|sk_|whsec_|https?:\/\//, label)
  }
})

// ---- DR-13: the payment page of the order is not confirmed ------------------------------------------------------------------------------------------------------------------
test('DR-13: RESERVATION_UNRESOLVED and PAYMENT_PAGE_CLOSE_UNCONFIRMED never say or imply that nothing was charged, never promise an automatic unblock, say the state is not confirmed, and send to the order and to the shop before another payment is started', () => {
  const denies = /addebit|charged|no charge|nothing (has been|was|is) |nessun (costo|pagamento|addebito)|nulla è stato|non è stato (pagat|addebit)|gratuit|senza alcun|non (hai|ha) pagato|not (been )?paid/i
  const promises = /automatic|da sol[oa]|tra qualche (istante|minuto)|a breve|presto|si risolv|sbloc|riprova|riprovare|try again|will be|ricominci|nuov[ao] chiave|new key/i
  for (const code of ['RESERVATION_UNRESOLVED', 'PAYMENT_PAGE_CLOSE_UNCONFIRMED']) {
    for (const status of [502, 503]) {
      const f = classifySessionFailure(status, { code, retry: true })
      const sentence = failureMessage(f, money)
      assert.equal(f.kind, 'payment_page_unconfirmed', code)
      assert.equal(denies.test(sentence), false, `${code}: ${sentence}`)
      assert.equal(promises.test(sentence), false, `${code}: ${sentence}`)
      assert.match(sentence, /non è confermato/, 'it says the state is not confirmed')
      assert.match(sentence, /controlla lo stato dell'ordine/i)
      assert.match(sentence, /assistenza/i)
      // "another payment" appears once, as the thing to wait on - never as an invitation (the order and the shop are what it sends to)
      assert.equal((sentence.match(/un altro pagamento/g) ?? []).length, 1)
      assert.match(sentence, /Prima di avviare un altro pagamento, controlla lo stato dell'ordine[^.]*oppure contatta l'assistenza/)
      // it is not the sentence of any other kind
      for (const other of ['temporary', 'outcome_unknown', 'purchase_not_started', 'payment_in_progress', 'not_payable'] as const) assert.notEqual(sentence, failureMessage(failure(other), money), other)
    }
  }
  // and the generic temporary sentence is not what the payment path shows for them (it denies a charge: it is only for a QUOTE, which can charge nobody)
  assert.doesNotMatch(failureMessage(classifySessionFailure(503, { code: 'RESERVATION_UNRESOLVED', retry: true }), money), /Il servizio di pagamento non risponde/)
})
