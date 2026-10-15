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
   esistenti (`getOrderForUser`). Ospiti: token dedicato di 256 bit (derivato con HMAC dal segreto del server e dall'id ordine, vedi "Passo 2 – Token ospite"),
   salvato solo come hash (`guestAccessTokenHash`) con scadenza (`guestAccessExpiresAt`); la pagina mostra solo numero ordine, stato e totale (`Referrer-Policy: no-referrer`), mai
   file privati, indirizzi o dati personali.
3. **Tentativi e scadenze.** Un acquisto = un ordine (`checkoutKey` univoco; stessa chiave e stesso carrello restituiscono lo
   stesso ordine; stessa chiave con carrello diverso = 409). Tentativi ripetuti idempotenti (riga `PaymentAttempt` per sessione, al
   massimo 5 per ordine). Prima di annullare un ordine per sessione scaduta si rilegge Stripe e si controlla che non esista un
   pagamento riuscito o in elaborazione. Un pagamento confermato in ritardo viene registrato e segnalato, mai perso, e non
   autorizza una seconda produzione (la transizione a `queued` avviene solo da `awaiting_payment`, sotto blocco della riga).
4. **Stripe e affidabilità.** Prima versione: **solo carta e wallet compatibili** (`payment_method_types: ['card']` esplicito).
   Nessun metodo asincrono finché il flusso non è implementato e testato; una sessione completata ma non pagata è un'anomalia, non un
   pagamento. Si verificano incasso effettivo, importo, valuta e corrispondenza con l'ordine.
   **Transazioni PostgreSQL e chiamate a Stripe** (attuato al Passo 3): lo stato si legge da Stripe **fuori** da ogni transazione e le
   transazioni sono brevi. L'idea iniziale di "applicare solo cambiamenti monotoni (lo stato non regredisce mai, i rimborsi usano il
   massimo)" è stata **abbandonata** su richiesta dell'utente: gli stati di Stripe non formano una scala (un tentativo può fallire e
   riprovare, un rimborso può fallire e l'importo rimborsato può scendere, una sessione può scadere mentre un'altra è aperta), quindi
   una lettura più vecchia non si distingue da una più nuova guardando il valore. Al suo posto: un **permesso temporaneo per ordine**
   (vedi "Passo 3 – come si evitano gli aggiornamenti sovrapposti"), così lettura e applicazione dello stesso ordine non si sovrappongono mai.
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

Se importo o valuta non coincidono: l'ordine non è pagato, la produzione non parte, `paymentReviewReason` viene valorizzato. Dal Passo 3
la verifica è **una sola** (`lib/payment-verification.ts`) e vale per sessioni Checkout, PaymentIntent e fatture: nessun percorso
promuove un ordine senza passarci (prima il percorso `payment_intent.*` di S4 promuoveva `awaiting_payment → queued` senza confrontare l'importo).

## Piano a passi

| Passo | Contenuto | Stato |
|---|---|---|
| 1 | Migrazione del database, supporto EUR, estrazione del calcolo prezzi (`lib/checkout-quote.ts`), modulo imposte | **Completato** (vedi sotto) |
| 2 | Ordine in attesa + sessione Stripe; endpoint `quote` e `session`; tariffa di spedizione da configurazione; limitazione richieste; guardia fiscale in produzione; token ospite | **Completato** (vedi sotto) |
| 3 | Webhook per le sessioni, verifica unica (anche sul percorso PaymentIntent), lettura Stripe fuori transazione, avvio produzione una sola volta; chiusura degli ordini non pagati scaduti | **Completato** (vedi sotto) |
| 4 | Endpoint di stato, pagina di esito, passaggio dell'interfaccia al nuovo percorso | Da autorizzare |
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

## Passo 2 – risultati

**Il checkout vecchio (carta, con `paymentIntentId` scelto dal browser) è ancora attivo e ancora vulnerabile a S2/S2b/S3. Non deve essere
usato in produzione finché il Passo 6 non lo chiude.** I nuovi endpoint non sono ancora collegati all'interfaccia (Passo 4).

### I due endpoint

- `POST /api/checkout/quote` – corpo: `items`, `shipping: {method: pickup|ship}`, `rush`. Risposta: importi in centesimi interi
  (`items[]`, `itemsTotalCents`, `shipping`, `tax`, `totalCents`), `currency`, `canCheckout` e `unavailableReason`. Non crea nulla, non
  chiama Stripe, non espone percorsi di file, id interni o dati personali. Qualunque campo di prezzo/totale/stato inviato dal browser è
  rifiutato (400).
- `POST /api/checkout/session` – corpo: `checkoutKey` (casuale, stabile finché carrello e totale non cambiano), `expectedTotalCents` (il
  totale mostrato, usato **solo per confronto**), `items`, `shipping`, `rush`. Risposta: `orderId`, `orderNumber`, `url` della pagina Stripe,
  `expiresAt`, importi. Codici d'errore: `INVALID_REQUEST` 400, `INVALID_ORIGIN` 403, `PRICE_CHANGED` 409 (con il totale attuale),
  `CHECKOUT_KEY_CONFLICT` 409, `ORDER_NOT_PAYABLE` 409 (pagato / in elaborazione / annullato), `TOO_MANY_ATTEMPTS` 429, `RATE_LIMITED` 429
  (con `Retry-After`), `CHECKOUT_DISABLED` / `PAYMENTS_NOT_CONFIGURED` / `TAX_NOT_CONFIGURED` / `SHIPPING_NOT_CONFIGURED` /
  `CHECKOUT_UNAVAILABLE` 503, `PAYMENT_PROVIDER_UNAVAILABLE` 502 e `TEMPORARY_ERROR` 503 (con `retry: true`), `PAYMENT_PROVIDER_ERROR` 500.
  Nessun dettaglio di Stripe arriva al browser.

### Come si evitano ordini e sessioni duplicati (quattro livelli)

1. **Chiave del checkout** → un ordine. La chiave è legata a chi chiede (`sha256(utente|ospite + chiave)`, salvata solo come hash) ed è
   univoca nel database: tra più richieste identiche contemporanee ne inserisce una sola, le altre leggono quell'ordine. Stessa chiave con
   carrello, spedizione, urgenza o totale mostrato diversi → 409.
2. **Stesso cliente registrato, stesso carrello, stesso totale** entro un'ora, anche con chiavi diverse (più schede, storage cancellato):
   stesso ordine non pagato (blocco consultivo per cliente e carrello, quindi anche in contemporanea).
3. **Prenota, poi chiama Stripe, poi completa.** Una riga `PaymentAttempt` (`creating`) viene scritta in una breve transazione che blocca
   l'ordine; **nessuna transazione è aperta durante la chiamata a Stripe** (provato). La chiamata usa l'id del tentativo come chiave di
   idempotenza e parametri che dipendono solo da ordine e tentativo.
4. **Chiave di idempotenza di Stripe + `stripeSessionId` univoco.** Se il server muore dopo che Stripe ha creato la sessione ma prima di
   salvarla, il nuovo tentativo trova la prenotazione, ripete la stessa chiamata e Stripe restituisce la **stessa** sessione.

| Situazione | Esito |
|---|---|
| Doppio clic / richieste simultanee | un ordine, un tentativo, una sessione; stessa pagina di pagamento a tutti |
| Stripe irraggiungibile | 502 `retry`; ordine e prenotazione restano; il nuovo tentativo li riusa |
| Stripe ha creato la sessione ma la risposta è andata persa | il nuovo tentativo ottiene la stessa sessione |
| Il database non riesce a salvare la sessione appena creata | 503 `retry`; stessa sessione al nuovo tentativo |
| Stripe rifiuta la richiesta | tentativo `failed`, errore generico; nuovo tentativo possibile, massimo 5 per ordine |
| La risposta di Stripe non coincide con l'ordine (importo, valuta, id) | sessione chiusa presso Stripe, tentativo `failed`, nessuna pagina restituita |
| Pagina aperta e ancora valida | riconsegnata (richiede una lettura da Stripe) |
| Sessione scaduta presso Stripe | tentativo `expired`, nuova sessione sullo stesso ordine |
| Sessione completata presso Stripe | tentativo `processing`, nessuna nuova pagina (la conferma è del Passo 3) |
| Prenotazione abbandonata (più vecchia di 90 s) | chiusa (`stale_reservation`), non riutilizzata |

### Prezzi

Ogni importo è calcolato dal server con `lib/checkout-quote.ts` (`buildCardQuote`, lo stesso codice per anteprima e ordine). Il totale è
salvato sull'ordine e congelato: cambiare i prezzi dopo non lo tocca. `expectedTotalCents` serve a rifiutare (409 `PRICE_CHANGED`, nessun
ordine creato) un pagamento il cui totale non coincide con quello mostrato. Le righe inviate a Stripe (articoli, spedizione, IVA aggiunta)
sommano **esattamente** il totale; se non sommano, la sessione non viene creata. Nessun cliente ottiene il "checkout amministratore a
zero": un amministratore paga come tutti.

### Spedizione, IVA, valuta

- Spedizione: tariffa unica in `SHIPPING_FLAT_RATE_CENTS` (centesimi; `0` = gratuita **per scelta**). Mancante o non valida → la spedizione non
  è disponibile (503), mai gratuita. Solo Italia: Stripe raccoglie l'indirizzo con `allowed_countries: ['IT']`; l'indirizzo non viene
  chiesto né accettato dal browser e verrà salvato sull'ordine dopo il pagamento verificato (Passo 3).
- IVA: `lib/tax.ts`. Con `TAX_MODE` `exclusive` una riga "IVA" è aggiunta; con `inclusive` è solo registrata. In produzione, senza `TAX_MODE`
  valido, il checkout risponde 503 `TAX_NOT_CONFIGURED`. `none` va usato commercialmente solo se coerente con il regime fiscale reale.
- Valuta: quella dell'ordine (EUR previsto); le righe sono in quella valuta; una risposta di Stripe in altra valuta viene scartata.

### Interruttori e guardie

- `HOSTED_CHECKOUT_ENABLED=true` è **richiesto in produzione** per vendere con i nuovi endpoint (altrove è acceso). Motivo: finché il webhook
  delle sessioni (Passo 3) e le pagine del cliente (Passo 4) non esistono, una sessione pagata non diventerebbe un ordine pagato. Va acceso solo
  dopo il Passo 4.
- In produzione `BASE_URL` deve essere `https://…`: gli indirizzi di ritorno vengono solo da lì, mai dall'intestazione `Host`.
- Il server non si collega mai a un indirizzo preso dall'intestazione `Host`: anche la chiamata interna per la tavolozza dei colori usa `BASE_URL` (in produzione, solo quello). Il **vecchio** checkout ha ancora il ripiego sull'origine della richiesta quando `BASE_URL` manca (rischio preesistente, sparisce con il Passo 6).
- Richieste da altri siti (origine/Referer non coerenti) → 403. Corpo `application/json`, massimo 100 KB, massimo 50 righe.
- Limitazione: per indirizzo, per utente e per l'intero negozio (database, contatore atomico): `CHECKOUT_SESSION_RATE_MAX` (20), `CHECKOUT_QUOTE_RATE_MAX`
  (120), `CHECKOUT_GLOBAL_RATE_MAX` (300) ogni `CHECKOUT_RATE_WINDOW_SECONDS` (600). Il limite globale impedisce che un
  `X-Forwarded-For` falsificato permetta ordini illimitati.

### Token ospite

Un ospite riceve, nella risposta di `session`, un cookie `mw_checkout` (`HttpOnly`, `SameSite=Lax`, `Secure` quando la richiesta è https,
validità 72 ore) con `idOrdine.token`. Nel database restano solo l'hash SHA-256 e la scadenza (`guestAccessTokenHash`, `guestAccessExpiresAt`).
Il token **non è casuale ma derivato** (HMAC-SHA256 del segreto del server e dell'id ordine): ogni risposta per lo stesso ordine contiene lo
stesso valore, quindi doppio clic e tentativi ripetuti non possono sovrascrivere il token e lasciare nel browser un cookie non più valido (con
token casuali servirebbe ruotarlo a ogni richiesta, con una corsa tra richieste simultanee). Non è nell'indirizzo di ritorno, non viene
inviato a Stripe. Permetterà **solo** di leggere lo stato di quell'ordine (pagina e endpoint di stato: Passo 4). Provato che non apre file,
ricevute, API ordini né ordini di altri, e che non vale mai per ordini di un account. Cambiare `JWT_SECRET` invalida i token esistenti.

### Verifiche eseguite (Passo 2)

- `tests/security/s2s3-step2.sec.ts`: 43 test (quote, creazione dell'ordine, totale congelato, duplicati e concorrenza, errori di Stripe e del
  database, tentativi, guardie di produzione, indirizzi di ritorno, origine, limitazione, token ospite, assenza di transazioni aperte durante
  le chiamate a Stripe). Provati con **mutazioni**: 11 protezioni rotte di proposito (gestione della chiave duplicata, chiave di idempotenza
  casuale, confronto del totale, spedizione a zero, controllo della risposta di Stripe, limite dei tentativi, guardia fiscale, ordini pagati,
  token per ordini di account, indirizzo di ritorno dalla richiesta, indirizzo interno dalla richiesta) e una chiamata a Stripe dentro una transazione: ogni volta almeno un test fallisce.
- Server vero (`next start`, produzione, SDK Stripe reale con la rete simulata): anteprima, sessione, ripetizione (stessa pagina), 8 richieste
  simultanee (1 ordine, 1 tentativo), stesso identificativo con carrello diverso (409), totale forzato (400), altra origine (403); i parametri
  realmente serializzati dallo SDK contengono `payment_method_types[0]=card`, `allowed_countries=IT`, `client_reference_id`, `expires_at`, righe che
  sommano il totale e la chiave di idempotenza.
- `lint`, `typecheck`, `build`: OK. `npm test` 217/219 (solo i 2 preesistenti); `test:api` 7/7; `test:contracts` 14/14; suite di sicurezza 144 test,
  141 superati, 0 falliti, 3 `todo` (S2, S2b, S3: vecchio percorso ancora aperto). Il confronto con lo snapshot del Passo 1 (72 scenari) è
  rimasto identico: il vecchio checkout non è cambiato.

### Non verificato / limiti

- Nessuna prova con Stripe reale (pagina ospitata, scadenza reale a 32 minuti, carte, wallet). I parametri sono stati verificati contro lo
  SDK e un Stripe simulato a livello HTTP, non contro Stripe.
- **Nessun pagamento viene ancora riconosciuto**: l'ordine resta `awaiting_payment` anche se il cliente paga. Webhook per le sessioni, verifica di
  importo/valuta, ricevute, notifiche, PrintLab, StockWorks e rapporto di producibilità (oggi generato dal vecchio checkout) arrivano al Passo 3.
- Gli ordini non pagati (sessione scaduta, abbandono) restano `awaiting_payment` finché il Passo 3 (evento di scadenza) e il Passo 5 (script) non li chiudono.
- I tentativi chiusi dal Passo 2 (`expired`, `processing`, `failed`) sono decisioni prudenti locali; la verità sul pagamento resta di Stripe e del Passo 3.
- La fatturazione per organizzazione (codici progetto/reparto, approvazioni) non è supportata dal nuovo checkout: gli ordini sono personali o ospite.
- `Secure` sul cookie ospite segue la stessa regola del cookie di accesso: serve `X-Forwarded-Proto: https` dal proxy oppure `COOKIE_SECURE=true`.
- L'indirizzo IP per la limitazione viene da `X-Forwarded-For`: va configurato il proxy di produzione perché lo imposti (Fase 7). Il limite globale
  resta comunque valido.
- L'anteprima consulta ancora, come il vecchio checkout, la tavolozza dei colori tramite una chiamata HTTP interna all'applicazione stessa.
- Simultaneità con chiavi diverse per **ospiti**: non c'è identità per riconoscere lo stesso acquisto; vale solo la chiave (il browser la conserva).

## Passo 3 – risultati

**Un pagamento riuscito viene riconosciuto anche se il browser si chiude**, con una verifica unica di importo, valuta, stato e ordine, e una
produzione che parte al massimo una volta. Il checkout vecchio è bloccato in produzione. Le pagine del cliente (Passo 4) non esistono ancora:
`HOSTED_CHECKOUT_ENABLED` resta spento in produzione fino ad allora.

### Moduli

| Modulo | Compito |
|---|---|
| `lib/payment-verification.ts` | Puro (nessun database, nessuna rete). Dice se un pagamento è valido per **quell'ordine** (`verifyPaymentIntent`, `verifyCheckoutSession`, `verifyInvoice`), cosa può fare all'ordine (`decidePaymentUpdate`) e se una scadenza permette di annullare (`mayCancelAfterExpiry`). |
| `lib/payment-sync.ts` | L'unico codice che scrive lo stato di pagamento da dati di Stripe: permesso per ordine, lettura da Stripe, applicazione. Usato dal webhook, dall'aggiornamento manuale dell'amministratore e dalla creazione dell'ordine del vecchio flusso. |
| `lib/order-effects.ts` | Effetti dopo il pagamento (ricevuta, rapporto di producibilità, inventario, PrintLab, notifiche): una sola esecuzione, riprovabili. |
| `lib/order-metadata.ts` | Modifica dei metadati dell'ordine sotto blocco della riga (nessuna scrittura "leggi e riscrivi" che perda modifiche). |
| `lib/stripe-metadata.ts` | Funzioni pure spostate da `lib/stripe-payments.ts` (nessun cambio di logica). |
| `lib/stripe-webhook.ts` | Classifica l'evento (PaymentIntent / carica / sessione / fattura), controlla `livemode`, chiama `syncPayment`. |

Migrazione additiva `20261017120000_payment_sync_lease`: su `PrintOrder` `paymentSyncLeaseId`, `paymentSyncLeaseUntil`, `paymentSyncedAt`.

### La verifica unica (stessa per ogni percorso)

Un ordine diventa **pagato** solo se, secondo Stripe **adesso**:

- il PaymentIntent è `succeeded` e punta a **quell'ordine e quel tentativo** (`metadata.orderId` / `attemptId`, per le sessioni della nostra
  `PaymentAttempt`: anche una sessione valida ma di un altro ordine non conta);
- `amount` (richiesto) **e** `amount_received` (incassato) coincidono esattamente con `order.totalCents`;
- la valuta coincide con quella dell'ordine; la sessione ha `mode=payment`, `status=complete`, `payment_status=paid`.

Qualunque altra combinazione dà un esito che **non** autorizza la produzione: `processing`, `authorized` (`requires_capture`), `unpaid`,
`canceled`, `expired`, oppure `mismatch` (importo, valuta, riferimento d'ordine o di sessione, modalità, PaymentIntent mancante, "completata ma non pagata").
Un `mismatch` lascia l'ordine non pagato, scrive `paymentReviewReason` e `metadata.paymentReview`, e segna il tentativo `mismatch`.

Dopo il pagamento verificato l'ordine passa a `queued` **solo da `awaiting_payment`**, **solo se** non ha un motivo di controllo e **solo se**
l'indirizzo di consegna di Stripe è accettabile (paese in `SHIPPING_COUNTRIES`, indirizzo presente se si spedisce). Altrimenti resta pagato ma
fermo (`awaiting_review`, `shipping_country` / `shipping_address_missing`). Altri motivi di controllo: `payment_already_used` (lo stesso
pagamento è già di un altro ordine), `duplicate_payment` (secondo pagamento diverso su un ordine già pagato), `paid_after_cancel` (soldi arrivati
dopo l'annullamento), `status_regression` (Stripe mostra "non pagato" per un ordine che avevamo pagato), `dispute`.

### Come si evitano gli aggiornamenti sovrapposti (permesso per ordine)

Una lettura fatta prima non deve poter sovrascrivere una più recente, **senza presumere che gli stati di Stripe vadano sempre avanti** (rimborsi,
annullamenti, tentativi che falliscono e riprovano). Per questo non si confrontano i valori: si impedisce la sovrapposizione.

1. **Permesso** (transazione breve): si bloccano le righe degli ordini interessati e si prende un permesso (id casuale + scadenza 45 s). Se un altro
   ciclo ne ha uno valido sullo stesso ordine, si attende (massimo `PAYMENT_SYNC_MAX_WAIT_MS`, 8000 ms) e poi si risponde con un errore riprovabile.
2. **Lettura** da Stripe (timeout 8 s): **nessuna transazione aperta, nessuna riga bloccata**.
3. **Applicazione** (transazione breve): si bloccano di nuovo le righe, si controlla che il permesso sia ancora **nostro** (altrimenti non si scrive
   nulla e l'evento resta non registrato), si registra l'evento, si verifica, si scrive, si libera il permesso.
4. **Effetti** dopo la conferma della transazione.

Poiché due cicli sullo stesso ordine non si sovrappongono mai, chi legge dopo applica dopo: ciò che resta salvato è sempre l'ultima cosa detta da
Stripe. Un permesso lasciato da un processo morto scade da solo (e viene ripreso); un ciclo che torna dopo la scadenza non scrive. L'evento è solo
un **indizio** su cosa guardare: il suo contenuto non diventa mai lo stato (un evento "scaduta" vecchio non annulla un ordine pagato, un "fallito" vecchio
non cancella un pagamento riuscito).

### Cosa succede nelle situazioni difficili

| Situazione | Esito |
|---|---|
| Il cliente paga e chiude il browser | Il webhook (`checkout.session.completed` o `payment_intent.succeeded`) legge Stripe e porta l'ordine a pagato e `queued`. Nessuna pagina del cliente è necessaria. |
| Lo stesso evento arriva due volte / eventi diversi per lo stesso pagamento / 8 insieme | Un solo avvio della produzione; gli eventi vengono registrati una volta ciascuno; gli effetti non si ripetono. |
| Eventi in ordine sbagliato (scaduta dopo pagata, fallita dopo riuscita, rimborso che scende) | Conta lo stato letto da Stripe al momento dell'applicazione; l'ordine non torna indietro per un evento vecchio. Un ordine pagato che Stripe mostra non pagato → `status_regression`, nessuna modifica automatica. |
| Importo, valuta, riferimento d'ordine o stato diversi | Non pagato, non rilasciato, in controllo. |
| Sessione scaduta | Si rilegge Stripe: annullata solo se non c'è pagamento riuscito/in corso e nessun altro tentativo vivo. Scaduta ma con pagamento riuscito → pagato. |
| Pagamento dopo scadenza o annullamento | Registrato (`paid_after_cancel`), mai perso, **non** avvia la produzione. |
| Secondo pagamento sullo stesso ordine / stesso pagamento su un altro ordine | `duplicate_payment` / `payment_already_used`: nessuna seconda produzione. |
| Stripe non risponde o dà errore | L'evento non viene registrato e il webhook risponde 5xx: Stripe lo riprova. L'ordine non viene toccato (provato: non annullato, non pagato). |
| PostgreSQL fallisce durante l'applicazione | Transazione annullata, permesso liberato, evento non registrato, risposta 5xx; il tentativo successivo riesce. |
| Pagamento che nessun ordine rivendica | Evento registrato con `orderId = null` ed elencato (`findUnmatchedPaymentEvents`); smette di essere elencato quando un ordine lo rivendica. |
| Contestazione, rimborso | Registrati sull'ordine (`dispute`, importi rimborsati); la ricevuta viene rigenerata se l'importo rimborsato cambia. |

### Effetti dopo il pagamento

Ricevuta, rapporto di producibilità, inventario, PrintLab e notifiche non decidono nulla sul pagamento e non girano nella transazione: un effetto che
fallisce non annulla un pagamento verificato. Ognuno ha un segno in `metadata.postPayment.<effetto>` (`running` → `done` / `skipped` / `failed`, con numero di
tentativi): `done` e `skipped` non si ripetono, `failed` o un `running` abbandonato (più vecchio di 5 minuti) si rieseguono; due esecuzioni insieme: ne vince una.
Il recupero è `recoverPostPaymentEffects` (verrà richiamato dallo script del Passo 5). PrintLab parte solo se l'ordine è `queued` e PrintLab è configurato.

### Vecchio checkout con carta (solo per migrazione e prove)

- In produzione `POST /api/checkout` con carta risponde 503 `LEGACY_CARD_CHECKOUT_DISABLED` **a meno che** sia impostato `LEGACY_CARD_CHECKOUT_ENABLED=true`.
  Il controllo ambiente admin lo segnala come errore se è acceso in produzione. Fuori produzione resta attivo (serve alle prove).
- Anche quando è acceso, ora verifica il PaymentIntent con la stessa funzione (importo, valuta, stato) → 400 `PAYMENT_MISMATCH`; un PaymentIntent già usato
  da un altro ordine → 409 `PAYMENT_ALREADY_USED`; la stessa richiesta ripetuta dallo stesso utente per lo stesso totale restituisce l'ordine già creato.
  I test `todo` S2, S2b e S3 sono diventati test di regressione.
- La rimozione definitiva resta al Passo 6.

### Token ospite: più ordini dallo stesso browser

Il cookie `mw_checkout` ora contiene un **elenco** `idOrdine.token~idOrdine.token…` (massimo 5, il più recente per primo), invece di un solo valore che un secondo
ordine avrebbe sovrascritto. Il token resta derivato con HMAC (nessuna rotazione, quindi nessuna corsa tra richieste), nel database c'è solo l'hash e la
scadenza (72 h); ogni voce è comunque controllata contro l'hash dell'ordine richiesto, quindi una voce falsa o vecchia non apre nulla. Resta valido il limite: il token
apre soltanto lo stato del proprio ordine.

### Configurazione di Stripe (da fare al momento del lancio)

Sul punto di arrivo dei webhook (`/api/stripe/webhook`) vanno abilitati questi eventi: `checkout.session.completed`, `checkout.session.expired`,
`payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`,
`charge.refund.updated`, `charge.dispute.created`, `invoice.sent`, `invoice.finalized`, `invoice.updated`, `invoice.paid`, `invoice.payment_failed`,
`invoice.voided`, `invoice.marked_uncollectible`. `STRIPE_WEBHOOK_SECRET` va impostato (senza di esso il webhook risponde 500). Nuove variabili:
`LEGACY_CARD_CHECKOUT_ENABLED` (lasciare spenta), `PAYMENT_SYNC_MAX_WAIT_MS` (facoltativa, predefinito 8000).

### Verifiche eseguite (Passo 3)

- `tests/security/s2s3-step3.sec.ts`: 45 test (pagamento corretto senza ritorno del browser; importo, valuta e riferimenti sbagliati via sessione e via PaymentIntent;
  sessione manomessa o di un altro ordine; completata ma non pagata; fatture; paese e indirizzo di spedizione; eventi duplicati, simultanei e fuori ordine;
  stati che vanno avanti e indietro con lettura lenta; rimborso che scende; attesa per ordine che non blocca altri ordini; scadenza, pagamento tardivo e doppio pagamento;
  contestazione; errore di Stripe; errore di PostgreSQL provocato con un vincolo temporaneo; permesso ripreso/occupato/perso; nessuna transazione aperta durante le letture;
  produzione mai avviata per pagamenti non verificati; effetti riprovati e non ripetuti; eventi senza ordine; aggiornamento manuale dell'amministratore; blocco del vecchio checkout e
  controllo ambiente; elenco dei cookie ospite). `s2-checkout-amount.sec.ts` (8) e `s3-orphan-payment.sec.ts` (3): erano `todo`, ora regressioni.
- **Prove di mutazione** (rompere una protezione di proposito e vedere che almeno un test fallisce): **24 mutazioni, tutte rilevate** (almeno un test fallisce per ciascuna; i sorgenti sono stati ripristinati e confrontati con una copia): permesso mai occupato, proprietà del permesso non controllata, permesso non liberato dopo un errore; importo richiesto, importo incassato, valuta, importo della sessione, riferimento all'ordine e appartenenza della sessione a un nostro tentativo non confrontati; un pagamento non coincidente che segna comunque pagato; ordine già pagato trattato come nuovo; ordine annullato rilasciato da un pagamento tardivo; ordine con motivo di controllo rilasciato; problema di consegna ignorato; annullamento per scadenza senza guardare gli altri tentativi; regressione di un pagamento seguita; pagamento già usato da un altro ordine accettato; effetti ripetuti anche se completati o già in esecuzione; vecchio checkout non bloccato in produzione, senza verifica dell'importo, con pagamento già usato accettato; cookie ospite che cancella gli ordini precedenti; ordine in controllo che accetta nuove pagine di pagamento. Alla prima esecuzione tre mutazioni (importo richiesto, riferimento d'ordine, ordine con motivo di controllo) non venivano rilevate: sono stati aggiunti i test mancanti.
- `lint`, `typecheck`, `build`: OK. `npm test` 217/219 (solo i 2 fallimenti preesistenti); `test:api` 7/7; `test:contracts` 14/14; suite di sicurezza 195 test,
  195 superati, 0 `todo` (S1, S4, S5, S6, S7, S2/S3 Passi 1 e 2 e confronto con lo snapshot di 72 scenari: nessuna regressione).
- **`npm test` 220 → 219**: nel Passo 2 è stato rimosso `buildStripeCheckoutSessionParams`, un'utilità inutilizzata che il piano aveva previsto e che il codice nuovo non usa, e con essa il suo
  unico test (`tests/stripe-payments.test.ts`, −20 righe). Nessun altro test è stato tolto; i test nuovi dei Passi 2 e 3 stanno nella suite di sicurezza (comando `test:security`), non in `npm test`.
- **Server reale** (`next start`, produzione, SDK Stripe reale con un Stripe simulato a livello HTTP che mantiene sessioni e PaymentIntent, webhook firmati): 53 verifiche superate su:
  anteprima e sessione, pagamento senza ritorno del browser, evento ripetuto, 8 webhook simultanei, importo/valuta/riferimento/stato sbagliati, "processing", evento "scaduta" vecchio dopo il pagamento, "fallito" vecchio
  dopo il successo, scadenza verificata, pagamento tardivo dopo annullamento, scadenza con pagamento riuscito, Stripe che dà errore 503 (webhook 5xx, nessun cambiamento, poi ripetizione riuscita), spedizione fuori paese e in Italia, pagamento senza ordine,
  cookie con due ordini, ripetizione della stessa richiesta, limitazione richieste (429), blocco del vecchio checkout in produzione, nessun ordine `queued` senza pagamento verificato,
  nessun PaymentIntent su due ordini. I 18 ordini creati hanno prodotto 18 sessioni con 18 chiavi di idempotenza distinte.

### Non verificato / limiti

- **Nessuna prova con Stripe reale** (pagina ospitata, carte, wallet, scadenza reale, firma dei webhook con il segreto reale, rimborsi e contestazioni veri). Gli oggetti simulati seguono la forma letta dal codice,
  ma non sono stati confrontati con risposte di Stripe vere.
- Le prove di concorrenza usano un solo processo del server (le richieste simultanee sono vere, ma stesso processo). Il permesso vive nel database, quindi non dipende dal processo, ma più processi
  contemporanei non sono stati provati.
- Se un ciclo tiene il permesso per più di `PAYMENT_SYNC_MAX_WAIT_MS` il webhook risponde errore e Stripe riprova (per giorni, con intervalli crescenti): corretto, ma significa che un ordine con Stripe lento può essere aggiornato qualche minuto dopo.
- Il recupero degli effetti (`recoverPostPaymentEffects`) e l'elenco dei pagamenti senza ordine non hanno ancora un comando: arrivano con lo script del Passo 5. **Fino ad allora un effetto fallito
  (ricevuta, rapporto, notifica, invio a PrintLab) non viene riprovato da solo**: l'ordine resta pagato e in produzione, con l'effetto segnato `failed` in `metadata.postPayment`. Si potrebbe
  riprovarlo anche a ogni evento successivo dello stesso pagamento (di solito ne arrivano due); non fatto, per non allargare il Passo 3 (decisione da confermare).
- L'aggiornamento manuale dell'amministratore (`/api/admin/orders/[orderId]/stripe-sync` e `stripe-attach`) parte da un PaymentIntent: non trova un ordine del nuovo checkout il cui PaymentIntent non è ancora collegato. Si risolve col Passo 5 (riconciliazione per sessione).
- Gli eventi salvati in `StripeEvent` ora contengono, per le sessioni, anche email e indirizzo del cliente (dati personali): serve una regola di conservazione/pulizia (da decidere prima del lancio).
- Due schede dello stesso browser che creano un ordine **nello stesso istante** possono sovrascriversi il cookie (ultima scrittura vince): l'ordine e il pagamento non ne risentono, ma lo stato di uno dei due non sarebbe più consultabile da quel browser. Rischio basso, documentato.
- `autoSubmitOrderToPrintLab` scrive i metadati dell'ordine senza blocco della riga (codice preesistente): una modifica concorrente degli stessi metadati potrebbe andare persa. Da sistemare quando PrintLab viene semplificato.
- Il percorso OrderWorks (creazione di ordini da una `JobForm`, `lib/orders.ts`) si fida dello stato di pagamento che la scheda dichiara: non è stato toccato né verificato nel Passo 3.
- **Trovato, preesistente e non toccato:** `POST /api/customer/orders/[orderId]/reprint` (`createReprintOrder` in `lib/orders.ts`) crea per un cliente registrato una copia di **qualunque suo ordine, anche non pagato**, con `status=queued` e `paymentStatus=pending`, e ne copia i metadati (compresa un'eventuale `productionAuthorization`). Provato con una prova temporanea: l'ordine nuovo è `queued`/`pending` e **non** idoneo alla produzione, quindi assegnazione stampante, coda automatica, PrintLab e sincronizzazione OrderWorks lo rifiutano (cancelli S5), ma ha stato "in coda" (le viste di coda non filtrano ancora per idoneità: vedi `PROGETTO.md`, punto 11). Non è un pagamento, quindi non rientra nel Passo 3: serve una decisione sul significato commerciale della "ristampa" (a pagamento? omaggio su approvazione?). Proposta: ammettere solo ordini già idonei alla produzione, creare la copia in `awaiting_review` (o `awaiting_payment` se è a pagamento) e non copiare `productionAuthorization`, `postPayment`, `paymentReview`.
- Il pagamento "completato ma non pagato" (metodi ritardati) è trattato come anomalia: nessun metodo ritardato è abilitato, quindi non è stato provato con un caso reale.
