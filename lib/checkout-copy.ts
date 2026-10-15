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
  canceledNotice: 'Hai interrotto il pagamento: non è stato addebitato nulla e il carrello è rimasto com\'è. Puoi riprovare quando vuoi.',
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
    case 'price_changed':
      return failure.currentTotalCents !== undefined
        ? `Il prezzo è cambiato: il totale ora è ${money(failure.currentTotalCents)}. Controlla il riepilogo e conferma di nuovo.`
        : 'Il prezzo è cambiato: controlla il riepilogo e conferma di nuovo.'
    case 'not_payable':
      return 'Questo ordine non può più essere pagato da qui: potrebbe essere già stato pagato o chiuso.'
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
