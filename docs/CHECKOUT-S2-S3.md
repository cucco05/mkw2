# Checkout con Stripe ospitato (S2 + S3) – architettura approvata e avanzamento

Documento di continuità per le correzioni **S2** (importo pagato non confrontato col totale) e **S3** (pagamento senza ordine).
Architettura approvata dall'utente, con le precisazioni riportate sotto. Lavoro solo sul ramo `claude/stampa3d-fase1`.
Stato dei passi in fondo al documento.

## Obiettivo

Un acquisto con carta è affidabile dall'anteprima dei costi fino all'avvio della produzione: l'ordine esiste **prima** del
pagamento con un totale congelato, il pagamento viene verificato **solo** con le informazioni di Stripe, e una produzione parte
al massimo una volta.

## Il flusso (solo carta, per ospiti e clienti)

1. **Anteprima costi** (`POST /api/checkout/quote`, Passo 2): calcolo puro, nessuna scrittura, nessun oggetto Stripe.
2. **"Paga"** (`POST /api/checkout/session`, Passo 2): il server ricalcola tutto, crea l'ordine `awaiting_payment` /
   `paymentStatus=pending` con totale congelato e `checkoutKey` (chiave idempotente), poi apre la sessione Stripe Checkout legata
   all'ordine (`client_reference_id`, metadati, riga `PaymentAttempt`). Risponde con l'URL di Stripe.
3. **Pagamento sulla pagina Stripe** (carta e wallet; indirizzo di spedizione ed email raccolti da Stripe).
4. **Conferma**: solo il webhook (o una rilettura lato server dello stato presso Stripe) marca l'ordine pagato. Il browser non
   invia né importi né stati.
5. **Ritorno del cliente**: pagina di esito con dati minimi (vedi "Consultazione degli ordini").

Stati (nessun nuovo enum):

| Situazione | Campi |
|---|---|
| Non pagato | `status=awaiting_payment`, `paymentStatus=pending` |
| Pagamento in elaborazione | `paymentStatus=processing` |
| Pagamento confermato | `paymentStatus=paid`, `paidAt` valorizzato |
| Autorizzato alla produzione | `status=queued`, impostato solo dalla transizione verificata (gate S5), una volta sola |
| Sessione scaduta / abbandonata | `status=cancelled` (dopo aver verificato che non esista un pagamento riuscito o in corso) |
| Da controllare | `paymentReviewReason` valorizzato, nessun avvio della produzione |

## Precisazioni dell'utente (vincolanti)

1. **IVA e prezzi.** `taxCents = 0` è provvisorio in sviluppo. Il sito **non deve poter essere pubblicato commercialmente senza una
   configurazione fiscale corretta**: modulo `lib/tax.ts` (modalità `none` / `inclusive` / `exclusive`, aliquota da
   configurazione, nessun sistema fiscale complesso). `TAX_MODE` non impostato = non configurato; in produzione il checkout a
   pagamento verrà rifiutato (guardia `getTaxSalesBlocker`, applicata al Passo 2) e il controllo ambiente admin lo segnala come
   richiesto. Tutti i prezzi mostrati sono interi in centesimi e coincidono col totale chiesto a Stripe. **Nessuna conversione
   automatica** degli importi storici USD in EUR senza una procedura esplicita (vedi `PROGETTO.md`, "Cambio di valuta").
2. **Consultazione degli ordini.** L'ID della sessione Stripe non autorizza nulla. Clienti registrati: controlli di accesso
   esistenti (`getOrderForUser`). Ospiti: token dedicato, casuale a 256 bit, salvato solo come hash (`guestAccessTokenHash`) con
   scadenza (`guestAccessExpiresAt`); la pagina mostra solo numero ordine, stato e totale (`Referrer-Policy: no-referrer`), mai
   file privati, indirizzi o dati personali.
3. **Tentativi e scadenze.** Un acquisto = un ordine (`checkoutKey` univoco; stessa chiave e stesso carrello restituiscono lo
   stesso ordine; stessa chiave con carrello diverso = 409). Tentativi ripetuti idempotenti (riga `PaymentAttempt` per sessione, al
   massimo 5 per ordine). Prima di annullare un ordine per sessione scaduta si rilegge Stripe e si controlla che non esista un
   pagamento riuscito o in elaborazione. Un pagamento confermato in ritardo viene registrato e segnalato, mai perso, e non
   autorizza una seconda produzione (la transizione a `queued` avviene solo da `awaiting_payment`, sotto blocco della riga).
4. **Stripe e affidabilità.** Prima versione: **solo carta e wallet compatibili** (`payment_method_types: ['card']` esplicito).
   Nessun metodo asincrono finché il flusso non è implementato e testato; una sessione completata ma non pagata è un'anomalia, non un
   pagamento. Si verificano incasso effettivo, importo, valuta e corrispondenza con l'ordine.
   **Transazioni PostgreSQL e chiamate a Stripe** (da attuare al Passo 3, rivedendo anche S4 con i suoi test come rete di
   sicurezza): leggere lo stato da Stripe **prima**, fuori dalla transazione; poi una transazione breve che registra l'evento,
   blocca la riga dell'ordine e applica solo cambiamenti monotoni (lo stato non regredisce mai, i rimborsi usano il massimo). Così
   un'istantanea più vecchia non può sovrascriverne una più recente e le richieste concorrenti restano serializzate dal blocco.
5. **Spedizioni.** Solo Italia, tariffa configurabile (configurazione dell'applicazione, senza chiamata a Stripe per l'anteprima).
   Il cliente conosce il costo complessivo prima di pagare. Indirizzo raccolto da Stripe con `allowed_countries: ['IT']`, paese
   ricontrollato nel webhook, salvato sull'ordine solo dopo il pagamento verificato. Shippo escluso.
6. **Semplicità.** Nessuna pagina amministrativa: la riconciliazione manuale è uno **script documentato** (prova di default,
   `--apply` per applicare). Nessuna dipendenza nuova.
7. **Continuità.** Protezioni S1, S4, S5, S6, S7 intatte; documentazione aggiornata dopo ogni attività.

## Regole di verifica del pagamento

Un ordine passa a pagato e a `queued` **solo se** valgono tutte le condizioni:

- la sessione Stripe esiste in `PaymentAttempt` e punta a quell'ordine (la fonte di verità è il nostro database, non i soli metadati);
- `mode=payment`, `livemode` coerente, `payment_status=paid`;
- `amount_total` e `amount_received` coincidono **esattamente** con `order.totalCents` e `attempt.amountCents`;
- la valuta coincide con quella dell'ordine;
- l'ordine è ancora `awaiting_payment`.

Se importo o valuta non coincidono: l'ordine non è pagato, la produzione non parte, `paymentReviewReason` viene valorizzato. Anche il
percorso `payment_intent.*` di S4 dovrà applicare lo stesso controllo (oggi promuove `awaiting_payment → queued` senza controllare
l'importo: è la ragione per cui la verifica diventa una funzione unica).

## Piano a passi

| Passo | Contenuto | Stato |
|---|---|---|
| 1 | Migrazione del database, supporto EUR, estrazione del calcolo prezzi (`lib/checkout-quote.ts`), modulo imposte | **Completato** (vedi sotto) |
| 2 | Ordine in attesa + sessione Stripe; endpoint `quote` e `session`; tariffa di spedizione da configurazione; limitazione richieste; guardia fiscale in produzione; token ospite | Da autorizzare |
| 3 | Webhook per le sessioni, verifica unica (anche sul percorso PaymentIntent), lettura Stripe fuori transazione, avvio produzione una sola volta | Da fare |
| 4 | Endpoint di stato, pagina di esito, passaggio dell'interfaccia al nuovo percorso | Da fare |
| 5 | Script di riconciliazione documentato (`npm run payments:reconcile`) | Da fare |
| 6 | Chiusura del vecchio ramo carta di `/api/checkout` (S2/S2b/S3 da `todo` a regressioni) | Da fare |
| 7 | Regressione completa, prove su server reale e browser, documentazione | Da fare |
| dopo | Rimozione di `CheckoutForm`, `createMakerWorksPaymentIntent` e delle dipendenze `@stripe/react-stripe-js` / `@stripe/stripe-js` (solo con approvazione) | Da approvare |

## Passo 1 – risultati

**Cosa è stato fatto** (nessun cambio visibile di comportamento):

- **Migrazione additiva** `20261015120000_checkout_payment_attempts`: nuova tabella `PaymentAttempt`; su `PrintOrder` le colonne
  `shippingCents`, `taxCents` (default 0), `checkoutKey` (univoca), `paidAt`, `paymentReviewReason`, `guestAccessTokenHash`,
  `guestAccessExpiresAt`; su `StripeEvent` le colonne `checkoutSessionId` e `orderId`. Nessuna colonna esistente è modificata.
- **EUR** in `lib/currency.ts` (formato italiano). Il default resta USD finché non si imposta `CURRENCY` / `NEXT_PUBLIC_CURRENCY`.
- **`lib/checkout-quote.ts`**: il calcolo spostato (senza riscriverlo) da `app/api/checkout/route.ts` in tre passi
  (`loadCheckoutContext`, `priceLineItems`, `computeCheckoutTotals`) più `CheckoutQuoteError`. Il percorso attuale li usa nello
  stesso ordine di prima, quindi gli errori e il loro ordine non cambiano. Rimosso `fallbackPrice`, codice morto (calcolato e mai usato).
- **`lib/tax.ts`** (modulare, `taxCents` = 0 se non configurato) agganciato ai totali; **totali in centesimi interi** (`toCents`).
- `recordCustomerOrder` salva anche `shippingCents` e `taxCents` degli ordini creati dal percorso attuale.
- Controllo ambiente admin: `TAX_MODE` è richiesto in produzione.

**Verifiche eseguite**

- Test di riferimento (`tests/security/checkout-golden.sec.ts`, 72 scenari: prezzi, sconti, parti, colori, spedizione, ruoli, organizzazioni,
  valute, ordini scritti su commit). Lo snapshot è stato registrato dal codice **prima** della modifica (`268b2bd`) in
  `tests/fixtures/checkout-golden.json`; il codice nuovo dà risposte identiche. Provato che il test sa fallire: due errori introdotti
  di proposito (arrotondamento del prezzo unitario, spedizione contata due volte) vengono rilevati.
- Migrazione provata su un database con ordini esistenti (USD e CAD, un evento Stripe): dati intatti, valori predefiniti corretti,
  nessuna conversione. Un test statico verifica che la migrazione resti additiva (e fallisce se vi si aggiunge un `DROP`).
- Nuovi test: `tests/tax.test.ts`, `tests/currency.test.ts`, `tests/security/s2s3-step1.sec.ts` (schema, vincoli di unicità, cascata,
  EUR, ordini storici invariati, tariffa di spedizione nella valuta dell'ordine, totale mostrato = totale salvato in tutte le modalità fiscali).
- `lint`, `typecheck`, `build`: OK. `npm test` 218/220 (solo i 2 fallimenti preesistenti); `test:api` 7/7; `test:contracts` 14/14;
  suite di sicurezza 101 test, 98 superati, 3 `todo` (S2, S2b, S3: ancora aperti per costruzione); S1, S4, S5, S6, S7 ancora verdi.
- Server reale (`next start`): anteprima in EUR con IVA "inclusive", ospite che prova "contanti" → 403 con l'elenco dei metodi permessi.

**Non verificato / limiti**

- La migrazione non è stata applicata a una copia dei dati di produzione (non esistono ancora): da fare prima del lancio con un backup.
- Nessuna prova con Stripe reale. L'interfaccia con EUR non è stata guardata nel browser (la pagina checkout non è stata modificata).
- Con `CURRENCY=EUR` i numeri di listino salvati nei campi `…Usd` e le variabili `*_USD` sono usati **così come sono** (come già accadeva
  per CAD/AUD): vanno rivisti esplicitamente in Fase 3. Non sono previste variabili `*_EUR`.
- Alcune somme amministrative aggregano `totalCents` senza distinguere la valuta (vedi `PROGETTO.md`, "Cambio di valuta").
