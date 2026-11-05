// Every sentence the new payment pages show, in ONE place (Italian is the main language of the site). Changing the language of these
// pages later means translating this file, nothing else: no component builds a sentence on its own. Plain data, no library.
// Pages that already exist keep their language until the dedicated translation phase.
import type { PublicCheckoutState } from '@/lib/checkout-status'
import { PURCHASE_PAGE_ERROR, type CheckoutFailure } from '@/lib/checkout-client'

export type StateCopy = { title: string; message: string; hint?: string }

export const CHECKOUT_STATE_COPY: Record<PublicCheckoutState | 'unknown', StateCopy> = {
  pending: {
    title: 'Pagamento non completato',
    message: 'Il pagamento di questo ordine non risulta ancora completato. Il carrello è rimasto com\'è: puoi riprendere il pagamento quando vuoi.',
    hint: 'Se hai già pagato, aspetta qualche istante: la conferma può richiedere un po\'.',
  },
  confirming: {
    title: 'Stiamo confermando il pagamento',
    message: 'Abbiamo ricevuto il tuo ritorno dalla pagina di pagamento e stiamo verificando l\'esito. Di solito servono pochi secondi.',
    hint: 'Puoi chiudere questa pagina: il pagamento viene registrato comunque.',
  },
  paid: {
    title: 'Pagamento ricevuto',
    message: 'Grazie! Il pagamento è stato verificato e il tuo ordine è in lavorazione.',
    hint: 'Conserva il numero d\'ordine: ti servirà se vuoi contattarci.',
  },
  attention: {
    title: 'Pagamento ricevuto, stiamo verificando l\'ordine',
    message: 'Il pagamento è stato ricevuto. Prima di avviare la stampa controlliamo alcuni dettagli dell\'ordine.',
    hint: 'Non devi fare nulla: ti contatteremo se serve.',
  },
  // (R1-2, S-06) A closed order says what the shop's records show - and nothing about the card or the account: the page of a closed order may still be open somewhere, and "closed"
  // is not a proof that nothing can be paid on it. It does not invite to start again.
  canceled: {
    title: 'Ordine chiuso',
    message: 'Questo ordine è stato chiuso e nei nostri registri non risulta pagato. Se hai effettuato un pagamento, non ripeterlo: contattaci e lo verifichiamo.',
    hint: 'Il carrello è rimasto com\'è.',
  },
  // Shown whenever this browser may not see the order (missing or expired access, another browser, an order that does not exist):
  // the same words for all of them, so the page never confirms that an order exists.
  unknown: {
    title: 'Non possiamo mostrare questo ordine da qui',
    message: 'Da questo browser non riusciamo a mostrarti l\'ordine: l\'accesso può essere scaduto oppure l\'ordine è stato fatto da un altro browser o dispositivo. Se hai pagato, il pagamento è registrato.',
  },
}

// Contact line for the "unknown" case. It does NOT promise that creating an account recovers a guest order.
export function supportLine(contactEmail?: string | null): string {
  const where = contactEmail && contactEmail.trim() ? contactEmail.trim() : 'l\'assistenza del negozio'
  return `Per ritrovare il tuo ordine scrivi a ${where} indicando il numero d\'ordine: verificheremo la tua identità prima di darti qualsiasi informazione.`
}

// (R1-2, S-06) The contact line of the notices that point to a payment to check. Like supportLine, it names the shop's address when the site has one, and it promises nothing but a check.
export function supportLineCheck(contactEmail?: string | null): string {
  const where = contactEmail && contactEmail.trim() ? contactEmail.trim() : 'l\'assistenza del negozio'
  return `Per verificare un pagamento scrivi a ${where} indicando il numero d\'ordine: verificheremo la tua identità prima di darti qualsiasi informazione.`
}

export const CHECKOUT_ACTIONS = {
  resume: 'Riprendi il pagamento',
  backToCart: 'Torna al carrello',
  keepWaiting: 'Controlla di nuovo',
  myOrders: 'I miei ordini',
} as const

// (R1-2, S-08, S-09) What the cart pages say once a verified payment has been dealt with. FOUR notes, because there are four different things to say and the customer must be able to tell
// them apart: the cart was emptied; the cart was NOT emptied because it may hold a NEW purchase; the job is not finished and the next visit to the cart finishes it; this cart can not be
// tied to that payment with certainty, so it was left as it is. None of them invites to pay, and none says the cart is empty unless it is.
const NOTE_IT = {
  emptied: 'Il carrello è stato svuotato.',
  kept: 'Il carrello non è stato svuotato perché potrebbe contenere un nuovo acquisto: controllalo prima di pagare di nuovo.',
  pending: 'Il pagamento è confermato e non serve pagare di nuovo. Da questa scheda non siamo riusciti a svuotare il carrello: riapri il carrello o ricarica la pagina per completare l\'operazione. Se non si risolve, puoi svuotare il carrello a mano.',
  unlinked: 'Il pagamento è confermato e non serve pagare di nuovo. Non riusciamo a collegare con certezza questo carrello a quel pagamento, quindi non lo abbiamo svuotato né modificato: controllalo prima di fare altro. Se hai dubbi, scrivici indicando il numero d\'ordine.',
} as const
const NOTE_EN = {
  emptied: 'Your cart has been emptied.',
  kept: 'Your cart has not been emptied because it may hold a new purchase: check it before paying again.',
  pending: 'Your payment is confirmed and you do not need to pay again. This tab could not empty your cart: reopen the cart or reload the page to finish. If this keeps happening, you can empty the cart yourself.',
  unlinked: 'Your payment is confirmed and you do not need to pay again. We cannot tie this cart to that payment with certainty, so we have not emptied or changed it: check it before doing anything else. If you have any doubt, write to us with the order number.',
} as const

// The page Stripe sends the customer back to (/checkout/success, step 4.3). The states themselves are CHECKOUT_STATE_COPY above.
export const STATUS_PAGE_COPY = {
  pageTitle: 'Esito del pagamento',
  loading: 'Controllo lo stato del tuo ordine…',
  orderNumberLabel: 'Ordine',
  totalLabel: 'Totale',
  asking: 'Controllo in corso…',
  waiting: 'Aspetto la conferma del pagamento. Controllo di nuovo tra qualche istante.',
  gaveUp: 'La conferma non è ancora arrivata. Puoi chiudere questa pagina: se il pagamento è andato a buon fine viene registrato comunque e l\'ordine risulterà confermato appena arriva.',
  errorTitle: 'Non riusciamo a controllare l\'ordine',
  errorMessage: 'Non siamo riusciti a ottenere lo stato dell\'ordine (connessione o servizio non raggiungibile). Questo non significa che il pagamento non sia andato a buon fine: riprova tra poco.',
  errorRetrying: 'Riproviamo da soli ogni pochi secondi.',
  retry: 'Riprova',
  keepShopping: 'Continua gli acquisti',
  guestKeep: 'Conserva il numero d\'ordine. Da questo browser potrai rivedere lo stato di questo ordine per qualche giorno.',
  goHome: 'Vai alla home',
  // the cart is kept until the server has verified the payment
  cartKept: 'Il tuo carrello resta salvato finché il pagamento non è confermato: così, se qualcosa non va, puoi riprendere da dove eri senza pagare due volte.',
  // after a verified payment (R1-2): the four notes of NOTE_IT
  cartEmptied: NOTE_IT.emptied,
  cartLeft: NOTE_IT.kept,
  cartPending: NOTE_IT.pending,
  cartUnlinked: NOTE_IT.unlinked,
} as const

// A payment for the cart in front of the customer was sent to the payment page earlier (cart and checkout pages, from the browser's memory + the server's answer).
export const PENDING_PAYMENT_COPY = {
  confirmingTitle: 'Hai un pagamento in conferma per questo carrello',
  confirmingMessage: 'Abbiamo già mandato questo carrello alla pagina di pagamento e stiamo aspettando l\'esito. Non serve pagare di nuovo: controlla lo stato dell\'ordine.',
  attentionTitle: 'Il pagamento di questo carrello è stato ricevuto',
  attentionMessage: 'Stiamo verificando l\'ordine prima di avviare la stampa. Non serve pagare di nuovo: ti contatteremo se serve.',
  paidTitle: 'Pagamento confermato',
  // (R1-2) says what the server verified and nothing about the cart: whether the cart was emptied is told, afterwards, by one of the notes below
  paidMessage: 'Il pagamento di questo carrello è stato verificato e l\'ordine è in lavorazione.',
  cartEmptiedNote: NOTE_IT.emptied,
  cartKeptNote: NOTE_IT.kept,
  cartPendingNote: NOTE_IT.pending,
  cartUnlinkedNote: NOTE_IT.unlinked,
  checkStatus: 'Controlla lo stato dell\'ordine',
  recheck: 'Ricontrolla',
  orderLabel: (number: string) => `Ordine ${number}`,
} as const

export type PendingPaymentCopy = { [K in keyof typeof PENDING_PAYMENT_COPY]: (typeof PENDING_PAYMENT_COPY)[K] extends (...args: infer A) => string ? (...args: A) => string : string }
// The cart page is still English (one language per page until the translation phase): same sentences, English.
export const PENDING_PAYMENT_COPY_EN: PendingPaymentCopy = {
  confirmingTitle: 'A payment for this cart is being confirmed',
  confirmingMessage: 'This cart has already been sent to the payment page and we are waiting for the result. You do not need to pay again: check the status of the order.',
  attentionTitle: 'The payment for this cart has been received',
  attentionMessage: 'We are checking the order before printing. You do not need to pay again: we will contact you if we need anything.',
  paidTitle: 'Payment confirmed',
  paidMessage: 'The payment for this cart has been verified and the order is in progress.',
  cartEmptiedNote: NOTE_EN.emptied,
  cartKeptNote: NOTE_EN.kept,
  cartPendingNote: NOTE_EN.pending,
  cartUnlinkedNote: NOTE_EN.unlinked,
  checkStatus: 'Check the order status',
  recheck: 'Check again',
  orderLabel: (number: string) => `Order ${number}`,
}

export function formatOrderNumber(orderNumber: number): string {
  return `MW-${String(orderNumber).padStart(5, '0')}`
}

// ====================================================================================================================================
// The checkout page (/checkout): every sentence, in one place. Amounts arrive already formatted by the caller.
// ====================================================================================================================================

export const HOSTED_CHECKOUT_COPY = {
  pageTitle: 'Riepilogo e pagamento',
  loadingCart: 'Sto caricando il carrello…',
  loadingQuote: 'Sto calcolando il totale…',
  updatingQuote: 'Aggiorno il totale…',
  emptyTitle: 'Il carrello è vuoto',
  emptyMessage: 'Aggiungi un modello o un prodotto per poter pagare.',
  goToShop: 'Vai al negozio',
  goToDiscover: 'Scopri i modelli',
  goToCart: 'Torna al carrello',
  changeInCart: 'Modifica nel carrello',
  // (R1-2, S-06) The address Stripe's "back" link leads to proves nothing (anybody can type it) and a payment page left open can still be paid: so the notice says the customer came back,
  // that the outcome may need checking, and what to do first. It denies nothing and invites to nothing.
  canceledNotice: 'Sei tornato dalla pagina di pagamento. L\'esito potrebbe richiedere una verifica: se hai pagato, controlla lo stato dell\'ordine prima di pagare di nuovo. Il carrello è rimasto com\'è.',
  deliveryTitle: 'Consegna',
  pickup: 'Ritiro',
  pickupNote: 'Gratuito',
  ship: 'Spedizione in Italia',
  shipUnavailable: 'La spedizione non è disponibile al momento: puoi scegliere il ritiro.',
  shipAddressNote: 'L\'indirizzo di consegna ti verrà chiesto nella pagina di pagamento.',
  summaryTitle: 'Il tuo ordine',
  subtotal: 'Subtotale',
  discount: 'Sconto',
  shipping: 'Spedizione',
  pickupFree: 'Ritiro (gratuito)',
  total: 'Totale',
  rush: 'Consegna urgente',
  rushNote: 'Scelta nel carrello',
  leadTimeLabel: 'Produzione stimata',
  leadTimeNote: 'Stima indicativa, non vincolante.',
  taxLabel: (ratePercent: number) => `IVA ${ratePercent}%`,
  taxIncluded: (ratePercent: number, amount: string) => `di cui IVA ${ratePercent}%: ${amount}`,
  lineQty: (qty: number, unit: string) => `${qty} × ${unit}`,
  leadTime: (hours: number) => (hours < 48 ? `circa ${Math.max(1, Math.round(hours))} ore` : `circa ${Math.max(2, Math.round(hours / 24))} giorni`),
  payButton: (amount: string) => `Paga con carta · ${amount}`,
  payButtonNoAmount: 'Paga con carta',
  paying: 'Ti porto alla pagina di pagamento…',
  payHint: 'Nella pagina successiva inserirai i dati della carta.',
  secureTitle: 'Pagamento sicuro',
  secureNote: 'Paghi con carta sulla pagina protetta di Stripe: non vediamo né conserviamo i dati della tua carta.',
  guestNote: 'Non serve un account: dopo il pagamento potrai seguire l\'ordine da questo browser. Per pagare da ospite usiamo un cookie tecnico, che serve solo a tenere separato il tuo pagamento da quello degli altri e a non addebitarti due volte.',
  // shown BEFORE the button when the browser itself says it keeps no cookies (a guest can not pay without the session cookie; the cart is untouched)
  cookiesOffNotice: 'In questo browser i cookie sono disattivati. Per pagare da ospite servono: tengono il tuo pagamento separato da quello degli altri e ti evitano un doppio addebito. Attivali per questo sito (oppure accedi al tuo account) e ricarica la pagina: il carrello non viene toccato.',
  billingLink: 'Sei un amministratore o un\'organizzazione? Vai alla fatturazione',
  retry: 'Riprova',
  removeUnavailable: 'Rimuovi gli articoli non disponibili',
  checkOrderStatus: 'Controlla lo stato dell\'ordine',
  // (S-11) After an unexpected error that may have followed a payment request the button is HELD: it says why, and what comes first. It promises nothing about the request.
  payHeld: 'Controlla l\'ordine prima di pagare di nuovo',
  // (S-11) The way back to a page that works from the start (the key of the purchase stays in the browser, so a later press is the same purchase)
  reloadPage: 'Ricarica la pagina',
  // an order and its payment page EXIST when this is shown (the server answered with the page's address): the sentence does not say that nothing happened
  stripeRedirectFailed: 'Non siamo riusciti ad aprire da qui la pagina di pagamento e non possiamo sapere se si aprirà più tardi o in un\'altra scheda: per saperlo, controlla l\'ordine e le altre schede aperte prima di riprovare.',
  lineProblem: 'Da correggere',
  partOfCompleteModel: 'Parte di un modello completo',
} as const

export function moneyText(cents: number, formatter: (amount: number) => string): string {
  return formatter(cents / 100)
}

// What to tell the customer about a failure. `money` formats whole cents in the currency of the quote.
export function failureMessage(failure: CheckoutFailure, money: (cents: number) => string): string {
  switch (failure.kind) {
    case 'network':
      return 'Non riusciamo a collegarci: controlla la connessione e riprova. Non è stato addebitato nulla.'
    case 'busy':
      return failure.retryAfterSeconds && failure.retryAfterSeconds <= 120
        ? `Troppe richieste in poco tempo: riprova tra ${failure.retryAfterSeconds} secondi.`
        : 'Troppe richieste in poco tempo: aspetta un momento e riprova.'
    case 'items':
      return 'Uno o più articoli del carrello non sono più disponibili. Rimuovili dal carrello per continuare.'
    case 'option':
      return 'Un colore o un\'opzione scelta non è più disponibile. Torna al carrello per cambiarla.'
    case 'minimum':
      return failure.minimumCents !== undefined
        ? `L\'ordine minimo è di ${money(failure.minimumCents)}: aggiungi qualcosa al carrello per continuare.`
        : 'L\'importo è inferiore all\'ordine minimo: aggiungi qualcosa al carrello per continuare.'
    case 'payment_minimum':
      return failure.minimumCents !== undefined
        ? `Il totale è inferiore al pagamento minimo con carta (${money(failure.minimumCents)}): aggiungi qualcosa al carrello per continuare.`
        : 'Il totale è inferiore al pagamento minimo con carta: aggiungi qualcosa al carrello per continuare.'
    case 'review':
      return 'Alcuni articoli non possiamo prepararli con il pagamento automatico (materiale, finitura o dimensioni da verificare). Questa richiesta non ha avviato nessun pagamento: puoi chiederci un preventivo manuale.'
    case 'price_changed':
      return failure.currentTotalCents !== undefined
        ? `Il prezzo è cambiato: il totale ora è ${money(failure.currentTotalCents)}. Controlla il riepilogo e conferma di nuovo.`
        : 'Il prezzo è cambiato: controlla il riepilogo e conferma di nuovo.'
    case 'not_payable':
      return 'Questo ordine non può più essere pagato da qui: potrebbe essere già stato pagato o chiuso.'
    case 'payment_in_progress':
      // the server names the order only to a customer it can show to own it; to a browser it only recognises by its session it says nothing more
      return failure.orderId
        ? 'Per questo carrello c\'è già un pagamento in conferma o in verifica: non serve pagare di nuovo. Controlla lo stato dell\'ordine.'
        : 'Per questo carrello c\'è già un pagamento in conferma o in verifica: non serve pagare di nuovo. Se hai appena pagato, l\'ordine risulterà confermato a breve.'
    case 'purchase_key_in_use':
      // (R1-1b, S-01) ONE sentence for every order and every state of it: it says what THIS request did (nothing new), what the page kept (the cart, the key) and what to do. It says
      // NOTHING about the purchase - not that it was paid, nor that it is being confirmed, nor that it ended - because the key alone must not be a way to read somebody else's
      // payment; and it promises neither that nothing was charged nor that the block goes away by itself. The code, when there is one, is made from the key alone: it is the way the
      // shop finds the purchase, and the shop checks who is writing before it says anything.
      return `Questa richiesta di pagamento risulta già collegata a un acquisto e da questo browser non può proseguire. Questa richiesta non ha avviato nessun nuovo pagamento e il carrello è rimasto com\'è. Per ritrovare l\'acquisto o per sapere come procedere, ${failure.supportCode ? `scrivici indicando il codice ${failure.supportCode}` : 'contatta l\'assistenza'}: prima di riprovare, attendi la risposta.`
    case 'outcome_unknown':
      // (S-11) An unexpected error of THIS page, found after a payment request may have gone out: the page does not even know whether it did. Like the sentence below it denies nothing, says where to
      // look BEFORE anything else, and asks to leave the cart alone - and it says why "pay" is off, because it is: the button is held until the order has been looked at.
      if (failure.code === PURCHASE_PAGE_ERROR) {
        return 'Si è verificato un errore imprevisto in questa pagina mentre il pagamento veniva avviato e non possiamo sapere se la richiesta sia partita né come sia andata. Per questo «Paga» è disattivato in questa pagina. Prima di fare altro, controlla l\'ordine: guarda le altre schede aperte di questo browser e, se hai un account, «I miei ordini». Non modificare il carrello finché non l\'hai verificato; poi ricarica la pagina. Se non sei sicuro, contatta l\'assistenza.'
      }
      // (R1-2, S-02) The request WENT OUT and nothing usable came back: the server may have made the order and the payment page, or not. The page does not know, so it says so, says where to
      // look BEFORE anything else is tried, asks to keep the cart as it is (it is the only thing that still leads back to the purchase), and denies nothing.
      return 'Non riusciamo a verificare come sia andata questa richiesta di pagamento: la risposta non è arrivata o non è chiara, quindi il sito non può sapere se è stata elaborata. Per saperlo, controlla l\'ordine: guarda le altre schede aperte di questo browser e, se hai un account, «I miei ordini». Finché non l\'hai verificato, evita di modificare il carrello e di avviare un altro pagamento. Se non sei sicuro, contatta l\'assistenza.'
    case 'payment_page_unconfirmed':
      // (DR-13) The server answered that it can not show the state of the payment page of this order (a page may exist, a payment may be on its way). So: the state is not confirmed; where to
      // look BEFORE another payment is started (the order, then the shop); the cart is as it was. It denies nothing about money, promises no unblock and no time, and invites to repeat nothing.
      return 'Lo stato della pagina di pagamento di questo ordine non è confermato e il sito non può dire se un pagamento sia stato avviato. Prima di avviare un altro pagamento, controlla lo stato dell\'ordine (guarda le altre schede aperte di questo browser e, se hai un account, «I miei ordini») oppure contatta l\'assistenza. Il carrello è rimasto com\'è.'
    case 'purchase_not_started':
      // (R1-2, S-05) About THIS page and what IT did - nothing was sent - and not about the cause, which this page can not know: another tab of the browser may still be using the payment, or the
      // browser's lock service failed.
      return 'Non siamo riusciti ad avviare il pagamento da questa scheda e non è stato inviato nulla; il carrello è rimasto com\'è. Può succedere se un\'altra scheda di questo browser sta ancora usando il pagamento, oppure per un problema momentaneo del browser. Controlla le altre schede aperte e l\'ordine, poi riprova.'
    case 'session_required':
    case 'cookies_blocked':
      return 'Il tuo browser non conserva i cookie di cui il pagamento ha bisogno. Attivali per questo sito (oppure accedi al tuo account) e riprova: il carrello è rimasto com\'è e questa richiesta non ha avviato nessun pagamento.'
    case 'too_many_attempts':
      return 'Troppi tentativi di pagamento per questo ordine. Torna al carrello e ricomincia.'
    case 'conflict':
      return 'La richiesta non corrispondeva al carrello attuale. Riprova.'
    case 'disabled':
      return 'Il pagamento online non è disponibile al momento. Riprova più tardi o contattaci.'
    case 'shipping_unavailable':
      return 'La spedizione non è disponibile al momento: scegli il ritiro oppure riprova più tardi.'
    case 'temporary':
      return 'Il servizio di pagamento non risponde in questo momento. Non è stato addebitato nulla: riprova tra qualche istante.'
    case 'invalid':
      return 'Non riusciamo a elaborare il carrello. Torna al carrello, controlla gli articoli e riprova.'
    case 'crypto_unavailable':
      // (R1-1a) The page could not make the secure key that stands between a repeated press and a second order, so it sent NOTHING. The sentence is about THIS page and THIS press
      // only: it says nothing about charges and nothing about payments started earlier, and it does not invite anyone to repeat a payment.
      return 'Il tuo browser non riesce a usare la funzione di sicurezza che serve per avviare il pagamento senza rischio di doppio ordine, quindi da questa pagina non è partita nessuna richiesta di pagamento. Il carrello è rimasto com\'è. Aggiorna il browser o provane un altro, poi ricarica la pagina. Questo avviso non riguarda eventuali pagamenti avviati in precedenza.'
    default:
      return 'Qualcosa non ha funzionato. Non è stato addebitato nulla: riprova.'
  }
}

// ====================================================================================================================================
// The CART page: it is an existing page and stays in English (uniform language) until the dedicated translation phase; its few new
// sentences are kept here with the others so that phase translates one file. The prices on that page are the server's (one price engine).
// ====================================================================================================================================
export const CART_COPY = {
  subtotal: 'Subtotal',
  discountApplied: 'Discount applied',
  updating: 'Updating prices…',
  priceUnavailable: 'Price unavailable',
  itemTotal: (amount: string) => `Item total: ${amount}`,
  unitTimesQty: (qty: number, unit: string) => `${qty} × ${unit}`,
  withDiscount: (percent: number) => `${percent}% discount included`,
  note: 'The total you pay, with delivery and tax, is confirmed at checkout.',
  retry: 'Try again',
  problem: 'Needs attention',
  // a complete model of several parts (step 4.6)
  completeModel: (parts: number) => `Complete model (${parts} parts)`,
  completeModelNote: 'One price for the whole model. Quantity and size apply to every part; colour and material can differ for each part.',
  completeModelTotal: (amount: string) => `Model total: ${amount}`,
  splitModel: 'Split into single parts',
  removeModel: 'Remove model',
  quantityOfModel: (qty: number) => `Quantity: ${qty} (set on the complete model above)`,
} as const

export function cartFailureMessage(failure: CheckoutFailure, money: (cents: number) => string): string {
  switch (failure.kind) {
    case 'network': return 'We cannot reach the server: check your connection and try again.'
    case 'busy': return 'Too many requests in a short time: wait a moment and try again.'
    case 'items': return 'One or more items in your cart are no longer available. Remove them to continue.'
    case 'option': return 'A colour or option you chose is no longer available. Change it to continue.'
    case 'payment_minimum':
      return failure.minimumCents !== undefined
        ? `The total is below the smallest card payment (${money(failure.minimumCents)}): add something to your cart to continue.`
        : 'The total is below the smallest card payment: add something to your cart to continue.'
    case 'review': return 'We cannot prepare some of these items with automatic payment (material, finish or size to check). Nothing has been charged: you can ask us for a manual quote.'
    case 'minimum':
      return failure.minimumCents !== undefined
        ? `${failure.itemsTotalCents !== undefined ? `Your items total ${money(failure.itemsTotalCents)}. ` : ''}The minimum order is ${money(failure.minimumCents)}: add something to your cart to continue.`
        : 'The order is below the minimum: add something to your cart to continue.'
    case 'disabled': return 'Online payment is not available right now. Please try again later or contact us.'
    case 'temporary': return 'The prices could not be calculated right now. Please try again in a moment.'
    case 'invalid': return 'We cannot calculate the prices for this cart. Check the items and try again.'
    default: return 'Something went wrong while calculating the prices. Please try again.'
  }
}

// ====================================================================================================================================
// Parts that would make a complete model but are bought one by one (step 4.6): the customer chooses before paying. One component, two languages: the cart
// page is still in English (see above), the checkout in Italian.
// ====================================================================================================================================
export type CompleteModelCopy = {
  title: (modelTitle: string) => string
  body: (total: string) => string
  mustChoose: string
  chosen: string
  group: string
  confirm: (total: string) => string
  cannotGroup: Record<'TOO_FEW' | 'OTHER_MODELS' | 'NOT_PARTS' | 'ALREADY_GROUPED' | 'DUPLICATE_PART' | 'QTY_DIFFERS' | 'SIZE_DIFFERS', string>
}

export const COMPLETE_MODEL_COPY_IT: CompleteModelCopy = {
  title: (modelTitle) => `Stai comprando le parti di «${modelTitle}» una per una`,
  body: (total) => `Le parti nel carrello bastano a formare un modello completo. Come parti singole ciascuna ha il proprio prezzo minimo; come modello completo il prezzo è quello del modello. Il subtotale attuale, con le parti singole, è ${total}.`,
  mustChoose: 'Scegli come procedere per poter pagare.',
  chosen: 'Hai scelto le parti singole: puoi comunque raggrupparle come modello completo.',
  group: 'Raggruppa come modello completo',
  confirm: (total) => `Confermo le parti singole · ${total}`,
  cannotGroup: {
    TOO_FEW: 'Non ci sono abbastanza righe da raggruppare.',
    OTHER_MODELS: 'Le righe appartengono a modelli diversi.',
    NOT_PARTS: 'Alcune righe non sono parti di un modello.',
    ALREADY_GROUPED: 'Alcune righe fanno già parte di un modello completo.',
    DUPLICATE_PART: 'Per raggrupparle ogni parte deve comparire una volta sola: unisci le righe uguali nel carrello.',
    QTY_DIFFERS: 'Per raggrupparle ogni parte deve avere la stessa quantità: modifica le quantità nel carrello.',
    SIZE_DIFFERS: 'Per raggrupparle ogni parte deve avere la stessa dimensione: portale alla stessa scala nel carrello.',
  },
}

export const COMPLETE_MODEL_COPY_EN: CompleteModelCopy = {
  title: (modelTitle) => `You are buying the parts of "${modelTitle}" one by one`,
  body: (total) => `The parts in your cart are enough to make a complete model. As single parts each one has its own minimum price; as a complete model the price is the model's. The current subtotal, with single parts, is ${total}.`,
  mustChoose: 'Choose how to continue to be able to pay.',
  chosen: 'You chose single parts: you can still group them as a complete model.',
  group: 'Group as a complete model',
  confirm: (total) => `Keep single parts · ${total}`,
  cannotGroup: {
    TOO_FEW: 'There are not enough lines to group.',
    OTHER_MODELS: 'The lines belong to different models.',
    NOT_PARTS: 'Some lines are not parts of a model.',
    ALREADY_GROUPED: 'Some lines are already part of a complete model.',
    DUPLICATE_PART: 'To group them each part must appear once: merge the identical lines in your cart.',
    QTY_DIFFERS: 'To group them every part needs the same quantity: change the quantities in your cart.',
    SIZE_DIFFERS: 'To group them every part needs the same size: set the same scale in your cart.',
  },
}

// ====================================================================================================================================
// "Ask for a manual quote": shown when some line cannot be made automatically (the server decides, lib/printability.ts). One component, two
// languages: the cart is still in English (see above), the checkout in Italian.
// ====================================================================================================================================
export type ManualQuoteCopy = {
  title: string
  intro: string
  line: (number: number) => string
  emailLabel: string
  emailHint: string
  nameLabel: string
  noteLabel: string
  notePlaceholder: string
  send: string
  sending: string
  sentTitle: string
  sent: (orderNumber: string, email: string) => string
  errors: Record<'EMAIL_REQUIRED' | 'REVIEW_NOT_REQUIRED' | 'RATE_LIMITED' | 'INVALID_REQUEST' | 'NETWORK' | 'OTHER', string>
  reason: (reason: { code: string; sizeMm?: { x: number; y: number; z: number }; usableMm?: { x: number; y: number; z: number }; value?: string }) => string
}

const size = (s: { x: number; y: number; z: number }) => `${s.x} × ${s.y} × ${s.z} mm`

export const MANUAL_QUOTE_COPY_EN: ManualQuoteCopy = {
  title: 'Ask for a manual quote',
  intro: 'We will look at your order, tell you what we can do (for example another material, a different size, or printing the model in several parts, only if you agree) and send you a price. Nothing is charged now.',
  line: (n) => `Item ${n}`,
  emailLabel: 'Your email',
  emailHint: 'Needed if you are not signed in: this is where we will answer.',
  nameLabel: 'Your name (optional)',
  noteLabel: 'Anything we should know (optional)',
  notePlaceholder: 'Use, deadline, preferred material…',
  send: 'Send the request',
  sending: 'Sending…',
  sentTitle: 'Request received',
  sent: (order, email) => `Your request ${order} has been received. We will write to ${email || 'you'} with a quote. Nothing has been charged.`,
  errors: {
    EMAIL_REQUIRED: 'Please enter your email address so that we can answer.',
    REVIEW_NOT_REQUIRED: 'This cart can be paid online: reload the page and use Checkout.',
    RATE_LIMITED: 'Too many requests: wait a few minutes and try again.',
    INVALID_REQUEST: 'Please check the email address and the text, and try again.',
    NETWORK: 'We cannot reach the server: check your connection and try again.',
    OTHER: 'The request could not be sent. Please try again.',
  },
  reason: (r) => {
    switch (r.code) {
      case 'NO_ACTIVE_MACHINE': return 'we cannot start automatic orders right now'
      case 'MATERIAL_UNKNOWN': return `the material "${r.value ?? ''}" is not one we offer`
      case 'MATERIAL_NOT_AVAILABLE': return `${r.value ?? 'this material'} is not available with automatic payment`
      case 'FINISH_UNKNOWN': return `the finish "${r.value ?? ''}" is not one we offer`
      case 'FINISH_NOT_AVAILABLE': return `the ${r.value ?? ''} finish is not available with automatic payment`
      case 'SIZE_UNKNOWN': return 'we could not read the size of this model'
      case 'UNIT_NOT_MM': return 'the model is not in millimetres, so its size needs checking'
      case 'SIZE_IMPLAUSIBLE': return 'the size of this model looks wrong and needs checking'
      case 'TOO_LARGE': return r.sizeMm && r.usableMm
        ? `at this scale it measures ${size(r.sizeMm)}, more than our printer makes in one piece (up to ${size(r.usableMm)})`
        : 'at this scale it is larger than our printer makes in one piece'
      case 'TOO_THIN': return 'at this scale a side is too thin to print reliably'
      case 'SUPPORT_HEAVY': return 'it needs a lot of supports, so we want to check it first'
      default: return 'it needs a check by a person'
    }
  },
}

export const MANUAL_QUOTE_COPY_IT: ManualQuoteCopy = {
  title: 'Richiedi un preventivo manuale',
  intro: 'Guardiamo il tuo ordine e ti diciamo cosa possiamo fare (per esempio un altro materiale, una misura diversa o la stampa in più parti, solo se sei d\'accordo) e ti mandiamo un prezzo. Ora non viene addebitato nulla.',
  line: (n) => `Articolo ${n}`,
  emailLabel: 'La tua email',
  emailHint: 'Serve se non hai effettuato l\'accesso: è l\'indirizzo a cui rispondiamo.',
  nameLabel: 'Il tuo nome (facoltativo)',
  noteLabel: 'Qualcosa che dovremmo sapere (facoltativo)',
  notePlaceholder: 'Uso, scadenza, materiale preferito…',
  send: 'Invia la richiesta',
  sending: 'Invio in corso…',
  sentTitle: 'Richiesta ricevuta',
  sent: (order, email) => `Abbiamo ricevuto la tua richiesta ${order}. Ti scriveremo a ${email || 'te'} con un preventivo. Non è stato addebitato nulla.`,
  errors: {
    EMAIL_REQUIRED: 'Inserisci il tuo indirizzo email, così possiamo risponderti.',
    REVIEW_NOT_REQUIRED: 'Questo carrello si può pagare online: ricarica la pagina e usa il pagamento.',
    RATE_LIMITED: 'Troppe richieste: aspetta qualche minuto e riprova.',
    INVALID_REQUEST: 'Controlla l\'indirizzo email e il testo, poi riprova.',
    NETWORK: 'Non riusciamo a collegarci: controlla la connessione e riprova.',
    OTHER: 'Non è stato possibile inviare la richiesta. Riprova.',
  },
  reason: (r) => {
    switch (r.code) {
      case 'NO_ACTIVE_MACHINE': return 'al momento non possiamo avviare ordini automatici'
      case 'MATERIAL_UNKNOWN': return `il materiale "${r.value ?? ''}" non è tra quelli che offriamo`
      case 'MATERIAL_NOT_AVAILABLE': return `${r.value ?? 'questo materiale'} non è disponibile con il pagamento automatico`
      case 'FINISH_UNKNOWN': return `la finitura "${r.value ?? ''}" non è tra quelle che offriamo`
      case 'FINISH_NOT_AVAILABLE': return `la finitura ${r.value ?? ''} non è disponibile con il pagamento automatico`
      case 'SIZE_UNKNOWN': return 'non siamo riusciti a leggere le dimensioni del modello'
      case 'UNIT_NOT_MM': return 'il modello non è in millimetri, quindi le dimensioni vanno verificate'
      case 'SIZE_IMPLAUSIBLE': return 'le dimensioni del modello sembrano errate e vanno verificate'
      case 'TOO_LARGE': return r.sizeMm && r.usableMm
        ? `con questa scala misura ${size(r.sizeMm)}, più di quanto la nostra stampante realizza in un pezzo solo (fino a ${size(r.usableMm)})`
        : 'con questa scala è più grande di quanto la nostra stampante realizza in un pezzo solo'
      case 'TOO_THIN': return 'con questa scala un lato è troppo sottile per essere stampato in modo affidabile'
      case 'SUPPORT_HEAVY': return 'richiede molti supporti, quindi preferiamo controllarlo prima'
      default: return 'va controllato da una persona'
    }
  },
}
