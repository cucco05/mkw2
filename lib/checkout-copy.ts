// Every sentence the new payment pages show, in ONE place (Italian is the main language of the site). Changing the language of these
// pages later means translating this file, nothing else: no component builds a sentence on its own. Plain data, no library.
// Pages that already exist keep their language until the dedicated translation phase.
import type { PublicCheckoutState } from '@/lib/checkout-status'

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
