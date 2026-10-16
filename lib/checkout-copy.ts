// Every sentence the new payment pages show, in ONE place (Italian is the main language of the site). Changing the language of these
// pages later means translating this file, nothing else: no component builds a sentence on its own. Plain data, no library.
// Pages that already exist keep their language until the dedicated translation phase.
import type { PublicCheckoutState } from '@/lib/checkout-status'
import type { CheckoutFailure } from '@/lib/checkout-client'

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
  canceled: {
    title: 'Sessione di pagamento scaduta',
    message: 'La pagina di pagamento è scaduta e l\'ordine è stato chiuso senza alcun addebito. Il carrello è rimasto com\'è.',
    hint: 'Puoi ricominciare il pagamento quando vuoi.',
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

export const CHECKOUT_ACTIONS = {
  resume: 'Riprendi il pagamento',
  backToCart: 'Torna al carrello',
  keepWaiting: 'Controlla di nuovo',
  myOrders: 'I miei ordini',
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
} as const

// A payment for the cart in front of the customer was sent to the payment page earlier (cart and checkout pages, from the browser's memory + the server's answer).
export const PENDING_PAYMENT_COPY = {
  confirmingTitle: 'Hai un pagamento in conferma per questo carrello',
  confirmingMessage: 'Abbiamo già mandato questo carrello alla pagina di pagamento e stiamo aspettando l\'esito. Non serve pagare di nuovo: controlla lo stato dell\'ordine.',
  attentionTitle: 'Il pagamento di questo carrello è stato ricevuto',
  attentionMessage: 'Stiamo verificando l\'ordine prima di avviare la stampa. Non serve pagare di nuovo: ti contatteremo se serve.',
  paidTitle: 'Pagamento confermato',
  paidMessage: 'Il pagamento di questo carrello è stato verificato: il carrello è stato svuotato e l\'ordine è in lavorazione.',
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
  paidMessage: 'The payment for this cart has been verified: the cart has been emptied and the order is in progress.',
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
  canceledNotice: 'Il pagamento non è stato completato e il carrello è rimasto com\'è. Puoi riprovare quando vuoi.',
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
  guestNote: 'Non serve un account: dopo il pagamento potrai seguire l\'ordine da questo browser.',
  billingLink: 'Sei un amministratore o un\'organizzazione? Vai alla fatturazione',
  retry: 'Riprova',
  removeUnavailable: 'Rimuovi gli articoli non disponibili',
  checkOrderStatus: 'Controlla lo stato dell\'ordine',
  stripeRedirectFailed: 'Non siamo riusciti ad aprire la pagina di pagamento. Non è stato addebitato nulla: riprova.',
  lineProblem: 'Da correggere',
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
      return 'Alcuni articoli non possiamo prepararli con il pagamento automatico (materiale, finitura o dimensioni da verificare). Non è stato addebitato nulla: puoi chiederci un preventivo manuale.'
    case 'price_changed':
      return failure.currentTotalCents !== undefined
        ? `Il prezzo è cambiato: il totale ora è ${money(failure.currentTotalCents)}. Controlla il riepilogo e conferma di nuovo.`
        : 'Il prezzo è cambiato: controlla il riepilogo e conferma di nuovo.'
    case 'not_payable':
      return 'Questo ordine non può più essere pagato da qui: potrebbe essere già stato pagato o chiuso.'
    case 'payment_in_progress':
      return 'Per questo carrello c\'è già un pagamento in conferma o in verifica: non serve pagare di nuovo. Controlla lo stato dell\'ordine.'
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
