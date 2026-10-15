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
| 4 | Endpoint di stato, pagina di esito, passaggio dell'interfaccia al nuovo percorso (piano approvato in sotto-passi 4.0–4.6) | **In corso**: 4.0 (interventi prioritari), 4.1 (endpoint di stato) e 4.2 (checkout nuovo) completati; **verifica 4.2-bis** (carrello, preventivo, Stripe) eseguita, con anomalie e proposte in attesa di approvazione; 4.3 (pagina di ritorno e ordini del cliente) da autorizzare |
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
  contemporanei non sono stati provati. **→ Provato nel Passo 4.0c con processi veri sulla stessa macchina (resta da provare l'infrastruttura vera: checklist 2.1).**
- Se un ciclo tiene il permesso per più di `PAYMENT_SYNC_MAX_WAIT_MS` il webhook risponde errore e Stripe riprova (per giorni, con intervalli crescenti): corretto, ma significa che un ordine con Stripe lento può essere aggiornato qualche minuto dopo.
- Il recupero degli effetti (`recoverPostPaymentEffects`) e l'elenco dei pagamenti senza ordine non hanno ancora un comando: arrivano con lo script del Passo 5. **Fino ad allora un effetto fallito
  (ricevuta, rapporto, notifica, invio a PrintLab) non viene riprovato da solo**: l'ordine resta pagato e in produzione, con l'effetto segnato `failed` in `metadata.postPayment`. Si potrebbe
  riprovarlo anche a ogni evento successivo dello stesso pagamento (di solito ne arrivano due); non fatto, per non allargare il Passo 3 (decisione da confermare).
- L'aggiornamento manuale dell'amministratore (`/api/admin/orders/[orderId]/stripe-sync` e `stripe-attach`) parte da un PaymentIntent: non trova un ordine del nuovo checkout il cui PaymentIntent non è ancora collegato. Si risolve col Passo 5 (riconciliazione per sessione).
- Gli eventi salvati in `StripeEvent` ora contengono, per le sessioni, anche email e indirizzo del cliente (dati personali): serve una regola di conservazione/pulizia (da decidere prima del lancio).
- Due schede dello stesso browser che creano un ordine **nello stesso istante** possono sovrascriversi il cookie (ultima scrittura vince): l'ordine e il pagamento non ne risentono, ma lo stato di uno dei due non sarebbe più consultabile da quel browser. Rischio basso, documentato.
- `autoSubmitOrderToPrintLab` scrive i metadati dell'ordine senza blocco della riga (codice preesistente): una modifica concorrente degli stessi metadati potrebbe andare persa. Da sistemare quando PrintLab viene semplificato.
- Il percorso OrderWorks (creazione di ordini da una `JobForm`, `lib/orders.ts`) si fida dello stato di pagamento che la scheda dichiara: non è stato toccato né verificato nel Passo 3. **→ Corretto nel Passo 4.0b (interruttore spento in produzione, stato dichiarato mai creduto).**
- **Trovato, preesistente e non toccato:** `POST /api/customer/orders/[orderId]/reprint` (`createReprintOrder` in `lib/orders.ts`) crea per un cliente registrato una copia di **qualunque suo ordine, anche non pagato**, con `status=queued` e `paymentStatus=pending`, e ne copia i metadati (compresa un'eventuale `productionAuthorization`). Provato con una prova temporanea: l'ordine nuovo è `queued`/`pending` e **non** idoneo alla produzione, quindi assegnazione stampante, coda automatica, PrintLab e sincronizzazione OrderWorks lo rifiutano (cancelli S5), ma ha stato "in coda" (le viste di coda non filtrano ancora per idoneità: vedi `PROGETTO.md`, punto 11). Non è un pagamento, quindi non rientra nel Passo 3: serve una decisione sul significato commerciale della "ristampa" (a pagamento? omaggio su approvazione?). Proposta: ammettere solo ordini già idonei alla produzione, creare la copia in `awaiting_review` (o `awaiting_payment` se è a pagamento) e non copiare `productionAuthorization`, `postPayment`, `paymentReview`. **→ Corretto nel Passo 4.0a come descritto sotto.**
- Il pagamento "completato ma non pagato" (metodi ritardati) è trattato come anomalia: nessun metodo ritardato è abilitato, quindi non è stato provato con un caso reale.

## Passo 4.0 – interventi prioritari (prima di qualsiasi interfaccia)

Dalle verifiche chieste dopo il Passo 3 sono emersi due modi di aggirare S5 e alcuni punti deboli del permesso di sincronizzazione. Sono stati corretti **prima** di scrivere l'interfaccia. Nessuna dipendenza nuova; nessuna migrazione.

### 4.0a – Ristampa (`POST /api/customer/orders/[orderId]/reprint`)

- **Problema (preesistente).** La copia dell'ordine ereditava *tutti* i metadati, compresa `productionAuthorization` di un amministratore: chi aveva un ordine autorizzato senza pagamento poteva generare copie **idonee alla produzione** senza limite. Inoltre la copia nasceva `queued`, con il vecchio totale, su qualunque ordine (anche non pagato).
- **Ora.** La richiesta del cliente è una **richiesta di nuovo preventivo** (`lib/reprint.ts`, `createReprintOrder`): stato `awaiting_review`, metodo e stato di pagamento `quote` (non verificato → mai idonea alla produzione), totali a 0 con `metadata.reprint.priceStatus = "to_be_quoted"` (le pagine mostrano "Price to be quoted", mai un importo zero), nessun metadato, pagamento, prezzo o autorizzazione ereditati (dagli articoli si tolgono anche i moltiplicatori di prezzo). Ammessa solo su ordini del cliente già evasi o falliti (`shipped`, `completed`, `failed`, `post_process`, `ready`) e idonei; **una sola richiesta aperta per ordine** anche con richieste simultanee (blocco consultivo di PostgreSQL); controllo dell'origine della richiesta e limite di 10 richieste l'ora per cliente; avviso agli amministratori (best effort).
- **Ristampa gratuita**: azione dell'amministratore con le regole esistenti (stato di produzione con `authorizeUnpaid`) **più motivo scritto obbligatorio** (almeno 10 caratteri) per gli ordini di ristampa (`checkManualTransition`, codice `AUTHORIZATION_REASON_REQUIRED`); l'autorizzazione resta registrata con id dell'amministratore, data e motivo e **non** trasforma l'ordine in "pagato". **Ristampa a pagamento**: l'amministratore usa la creazione ordine esistente (`POST /api/admin/orders`) con prezzi decisi da lui. Un "Riordina dal carrello" con prezzo ricalcolato dal server è un miglioramento futuro.
- **Prove.** `tests/security/reprint.sec.ts` (8 test) e 12 mutazioni (copia dei metadati, creazione come `queued`, totale e stato di pagamento ereditati, ordini non evasi accettati, controllo della richiesta aperta, blocco tra richieste simultanee, moltiplicatore di prezzo, motivo non richiesto, origine, limite) tutte rilevate.
- **Limiti.** I testi della pagina ordini del cliente sono in inglese come il resto di quella pagina (la lingua delle pagine esistenti è una decisione a parte). Le viste di produzione dell'amministratore mostrano ancora `awaiting_review` come "in coda" (`normalizeOrderStatus`, punto 11 di `PROGETTO.md`): la richiesta non può comunque essere assegnata a una stampante né inviata a PrintLab.

### 4.0b – OrderWorks in ingresso (`POST /api/makerworks/jobs`)

- **Dipendenze verificate.** Nessun codice interno chiama la rotta (la usa solo il servizio esterno OrderWorks) e nessun test la copriva. Il segreto `MAKERWORKS_INBOUND_SECRET` è **condiviso** con `printlab/jobs/[jobId]` e `models/[id]/gcodes`: resta. Restano anche `lib/orderworks-status.ts` (serve alla politica S5), `orderworks-sync/link`, `recordOrderWorksJob`, `createOrderFromJobForm` (usata anche da `PATCH /api/jobs/[paymentIntentId]`, azione di un amministratore), le pagine admin e la tabella `JobForm`: **non è stato tolto nulla**.
- **Problema.** Con il segreto, chi inviava poteva creare un ordine con importo, righe, metadati (anche una `productionAuthorization` già pronta) e stato `paid` a suo piacimento → `queued`; il segreto era accettato anche nell'indirizzo (`?secret=`, che finisce nei log).
- **Ora.** (1) Interruttore `ORDERWORKS_INBOUND_ENABLED` (`lib/orderworks-inbound.ts`): **spento in produzione** se non è `true`; la rotta risponde 503 `ORDERWORKS_INBOUND_DISABLED` prima di leggere il corpo e di controllare il segreto, quindi non scrive nulla (effettivo lato server). (2) Segreto solo in intestazione (`Authorization: Bearer`, `x-makerworks-secret`) o firma; mai nell'indirizzo. (3) Anche se acceso, l'ordine nato dal webhook **ignora lo stato di pagamento dichiarato**: nasce `awaiting_review`, `pending`, con `paymentReviewReason = external_order`, e anche se Stripe conferma l'importo dichiarato resta pagato **ma non rilasciato** (serve un amministratore). (4) I metadati che arrivano da fuori non possono contenere i nostri marcatori (`RESERVED_ORDER_METADATA_KEYS`: `productionAuthorization`, `paymentReview`, `postPayment`, `cancellation`, `reprint`, `checkout`, `stripe`, `artifacts`…), né dal webhook né da una scheda già salvata (`sanitizeExternalMetadata`, anche nel costruttore degli ordini). (5) Un ordine segnalato (`paymentReviewReason`) non viene spostato dagli aggiornamenti di evasione esterni. (6) Il controllo ambiente admin segnala come errore l'interruttore acceso in produzione.
- **Prove.** `tests/security/orderworks-inbound.sec.ts` (9 test) e 10 mutazioni rilevate (dopo aver aggiunto un test diretto sul costruttore, la mutazione sulla pulizia dei metadati non era rilevata dai soli test sul webhook).
- **Rischi residui.** Il segreto resta in uso per altre rotte (consigliati segreti distinti: solo configurazione). L'amministratore può ancora segnare "pagato" una scheda (`PATCH /api/jobs/[paymentIntentId]`): è un'azione esplicita ma non registrata come autorizzazione. Se qualcuno riaccende l'ingresso, gli ordini restano comunque non produttivi finché un amministratore non decide.

### 4.0c – Permesso di sincronizzazione tra processi, API ordini del cliente

- **Orologio del database.** Il permesso dura 45 s misurati con l'orologio di PostgreSQL (`clock_timestamp()`), non con quello dell'applicazione: un server con l'orologio sbagliato non può più accorciare o allungare il permesso di un altro.
- **Limite di lettura.** Tutte le letture da Stripe insieme devono finire entro il 55 % della durata del permesso (circa 25 s): oltre, `PaymentSyncReadTimeoutError`, nulla viene applicato, il permesso viene restituito subito e l'evento resta non registrato (Stripe lo riconsegna).
- **Punti per le prove.** `PAYMENT_SYNC_LEASE_TTL_MS` (da 0,5 s a 5 min; **solo per le prove**, predefinito 45 s) e `syncHooks.afterRead` (stesso schema di `effectHooks`).
- **Prove con processi veri** (`tests/security/payment-sync-multiprocess.sec.ts`, processi Node separati sullo stesso PostgreSQL con un Stripe finto): A) due processi sullo stesso ordine, letture mai sovrapposte, una sola produzione, effetti eseguiti una volta; B) un processo con l'orologio sfasato di un'ora ucciso con SIGKILL mentre tiene il permesso: l'altro attende la scadenza reale (2,5 s) e completa, nulla perso; C) un processo congelato (SIGSTOP) tra lettura e applicazione, permesso scaduto, un altro processo conclude; al risveglio (SIGCONT) il primo viene rifiutato (`PaymentSyncLeaseLostError`) e non applica nulla; D) raffica di 12 eventi da due processi: una produzione, 12 eventi registrati una volta, effetti una volta; E) lettura troppo lenta abbandonata, permesso restituito, il riprovo riesce. 6 mutazioni rilevate (permesso mai occupato, proprietà non controllata, scadenza ignorata, **orologio dell'applicazione**, nessun limite di lettura, permesso non restituito dopo un errore).
- **API ordini del cliente.** `GET /api/customer/orders` e `/[orderId]` restituiscono ora un **elenco consentito** di campi (`lib/customer-order-view.ts`): niente identificativi Stripe, chiave di checkout, hash dell'accesso ospite, permesso di sincronizzazione, motivo di verifica, campi contabili, assegnazione stampante e `metadata` (ciò che serve ai client sta in `derived`). Un campo aggiunto in futuro resta privato finché non lo si aggiunge a mano. `tests/security/customer-order-api.sec.ts` (3 test) e 4 mutazioni rilevate. Il contratto per l'app mobile (`docs/mobile-api-contracts.md`) è stato aggiornato.
- **Limiti.** Le prove usano più processi sulla **stessa macchina**; più macchine, la latenza verso il database e il proxy di produzione restano nella checklist (`CHECKLIST-PRELANCIO.md`, 2.1).

### Verifiche eseguite (Passo 4.0)

- `lint`, `typecheck`, `build`: OK. Suite di sicurezza **220/220** (0 `todo`; i 195 del Passo 3 + 25 nuovi); `npm test` 217/219 (solo i 2 preesistenti); `test:api` 7/7; `test:contracts` 14/14.
- **Server reale** (`next start` in produzione, due istanze sulla stessa base dati, una con l'interruttore spento e una acceso): 21 verifiche su 21 — webhook OrderWorks 503 anche con il segreto giusto e nessuna scrittura; acceso: segreto nell'indirizzo → 401, nell'intestazione accettato, ordine creato `awaiting_review`/segnalato/senza marcatori; API ordini senza campi interni; ristampa: senza intestazione di origine → 403, creata, ripetuta → stessa richiesta, ristampa di una richiesta → 409; amministratore: senza autorizzazione 409, senza motivo 409, con motivo 200 e autorizzazione registrata con il suo id; controllo ambiente admin coerente con l'interruttore.
- **Non verificato**: Stripe reale; più macchine; telefoni e browser veri (vedi `CHECKLIST-PRELANCIO.md`).

## Passo 4.1 – stato dell'ordine per le pagine di pagamento (solo server)

Nessuna interfaccia in questo passo: c'è l'endpoint che le pagine useranno, con le regole di accesso e di riservatezza provate. Nessuna dipendenza nuova, nessuna migrazione.

### `GET /api/checkout/status?order=<id>[&return=1]`

- **Chi può vedere un ordine** (`lib/checkout-status.ts`, `canViewOrder`): solo il proprietario con l'accesso attivo, oppure l'ospite il cui browser porta il **token di quell'ordine** (cookie `mw_checkout`, controllato contro l'hash e la scadenza salvati su quell'ordine; il cookie può contenere fino a 5 ordini). Non bastano: conoscere l'id dell'ordine (barra degli indirizzi, schermata, collegamento inoltrato), essere un altro cliente, essere staff o amministratore (usano le pagine admin), un token di un altro ordine, un token falso o scaduto, un token ospite su un ordine di un account. **Poter aprire la pagina di conferma senza accedere non rende pubblico alcun ordine**: la pagina è raggiungibile, i dati si chiedono all'endpoint, che controlla chi li chiede.
- **Tutti i rifiuti sono uguali**: 404 con lo stesso corpo per ordine inesistente, id malformato, nessun accesso, ordine del vecchio flusso (senza tentativi di pagamento) — l'endpoint non conferma mai che un ordine esiste. Anche il 404 e il 429 non sono memorizzabili.
- **Cosa risponde**: `orderNumber`, `state`, `totalCents`, `currency`, `final`, `pollAfterMs`. Mai nome, e-mail, indirizzi, file, identificativi di Stripe, motivi di verifica, id interni, metadati. Intestazioni su ogni risposta: `Cache-Control: no-store, private`, `Pragma: no-cache`, `Vary: Cookie`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex, nofollow`; nessun `ETag`, nessun cookie impostato. Esiste solo `GET`.
- **Stati** (`derivePublicState`, puri e provati su tutte le combinazioni):

| Stato | Quando | Cosa dice la pagina (testi in `lib/checkout-copy.ts`, in italiano) |
|---|---|---|
| `pending` | ordine in attesa, nessun pagamento riuscito (pagina di pagamento aperta o scaduta ma ordine ancora aperto) | "Pagamento non completato", si può riprendere |
| `confirming` | pagamento in elaborazione, oppure il cliente è tornato (`return=1`) e **non è stato possibile chiedere a Stripe** | "Stiamo confermando il pagamento" (ripetere dopo `pollAfterMs` = 2,5 s) |
| `paid` | pagamento verificato | "Pagamento ricevuto" |
| `attention` | pagato ma un incaricato controlla (paese di consegna, contestazione…), pagamento non coincidente, denaro arrivato dopo l'annullamento | "Pagamento ricevuto, stiamo verificando l'ordine" — **nessun motivo mostrato** |
| `canceled` | pagina scaduta e ordine chiuso senza addebito | "Sessione di pagamento scaduta" |
| (nessun accesso) | tutto il resto | testo neutro + contatto assistenza con verifica d'identità; **non** si afferma che registrarsi recuperi un ordine ospite |

- **Il browser non dichiara mai un pagamento.** `success_url` porta solo l'id ordine. `return=1` significa soltanto "sono tornato dalla pagina di pagamento": può trasformare "non pagato" in "stiamo confermando" quando Stripe non risponde; **non può produrre "pagato"** (provato con parametri `status`, `paid`, `session_id`, `redirect_status`…: nulla cambia, l'ordine resta intatto nel database). Lo stato "pagato" nasce solo dalla verifica unica del Passo 3.
- **Webhook in ritardo.** Se l'ordine aspetta ancora il pagamento e ha una pagina di pagamento che poteva essere pagata, l'endpoint **chiede a Stripe** (`syncPayment` sulla sessione, senza evento): chi ha pagato vede "pagato" anche prima del webhook, che poi arriva e risulta già applicato. Freni: al massimo una domanda ogni 4 s per ordine e 300 al minuto in tutto negozio (contatori nel database, quindi condivisi tra istanze), non si chiede se la lettura è recente (`paymentSyncedAt`) né per ordini già pagati, segnalati o chiusi; attesa massima di 1,5 s se un altro aggiornamento dello stesso ordine è in corso; gli effetti dopo il pagamento partono **in secondo piano** (`effects: "background"`), senza far attendere la pagina. Se Stripe non risponde: la risposta arriva comunque, dai dati che abbiamo.
- **Limiti**: per indirizzo, per ordine e globale, contati **prima** di cercare l'ordine e indipendenti da chi chiede (`CHECKOUT_STATUS_RATE_MAX` 240 e `CHECKOUT_STATUS_GLOBAL_RATE_MAX` 3000 per finestra); separati dai limiti di anteprima e di checkout; 429 con `Retry-After`.
- **Stima dei tempi nel preventivo**: ogni riga di `POST /api/checkout/quote` contiene `leadTimeHours` (ore stimate dal server, oppure `null`); nessun dato interno di prezzo.
- **Percorso pubblico**: nel proxy è pubblico **solo** il percorso esatto `/checkout/success` (la pagina arriva al Passo 4.3: fino ad allora risponde 404). `/cart` e `/checkout` **restavano dietro l'accesso** fino al Passo 4.2 (aperti in 4.2, vedi sotto): la pagina di checkout attuale usa ancora il vecchio flusso, che in produzione è bloccato, e aprirla agli ospiti prima del nuovo flusso darebbe loro una pagina rotta (scostamento motivato rispetto al piano, che prevedeva di aprirle in 4.1).
- **Testi nuovi** in un solo modulo (`lib/checkout-copy.ts`), in italiano, senza libreria di traduzione; le pagine già esistenti restano nella loro lingua fino alla fase di traduzione dedicata.

### Verifiche eseguite (Passo 4.1)

- `tests/security/s2s3-step4.sec.ts` (13 test): accesso del proprietario e dell'ospite, matrice dei rifiuti (altro cliente, staff, amministratore, nessun cookie, cookie di un altro ordine, token falso, token di un altro ordine, token scaduto, token ospite su ordine di account), rifiuti identici (anche id inesistenti, malformati e ordini del vecchio flusso), risposta senza dati personali/identificativi (anche dopo il pagamento e nei casi da controllare), il browser non dichiara il pagamento, webhook in ritardo (paga una volta, effetti una volta, webhook successivo senza effetti), Stripe irraggiungibile, richieste simultanee (una sola domanda a Stripe; ordine rilasciato una volta), scadenza e pagamento arrivato per primo, ordini pagati o segnalati non interrogati, limiti propri, stima dei tempi, nessuna risposta memorizzabile. `tests/checkout-status.test.ts` (7): regole pure e testi. `tests/public-asset-proxy.test.ts`: solo il percorso esatto è pubblico.
- **Prove di mutazione**: 18 protezioni rotte di proposito (token ospite ignorato, qualunque utente vede gli ordini degli account, "sono tornato" = pagato, motivo di verifica nella risposta, risposte memorizzabili, nessun limite, Stripe interrogato a ogni richiesta, ordini del vecchio flusso serviti, 403 al posto di 404, `Vary: Cookie` mancante, ordine segnalato mostrato come pagato o in attesa, freno alle letture rimosso, ordini pagati interrogati, "in conferma" per chi non è tornato, token ospite che apre ordini di account, `/checkout` pubblico, testo che promette il recupero registrandosi): tutte rilevate. Due non lo erano al primo giro (un test chiamava gli stessi punti in parallelo e si scambiava l'utente; un caso mancava): corretti i test.
- `lint`, `typecheck`, `build` OK; suite di sicurezza **233/233** (0 `todo`); `npm test` 227 (225 superati, solo i 2 fallimenti preesistenti); `test:api` 7/7; `test:contracts` 14/14. S1–S7 e il sistema Stripe del Passo 3 invariati (suite del Passo 3 completa tra i 233).
- **Server reale** (`next start` in produzione, Stripe simulato a livello HTTP, dati fittizi): 36 verifiche su 36 — percorso pubblico solo per `/checkout/success` (`/checkout`, `/cart`, `/customer/orders` rimandano all'accesso); accessi e rifiuti identici; intestazioni reali; pagamento senza webhook visto come "pagato" e rilasciato una volta, effetti completati in secondo piano (ricevuta, rapporto, notifica fatti; PrintLab saltato perché non configurato), webhook successivo senza effetti; Stripe giù (503 simulato) → "confirming", poi "paid"; 12 richieste simultanee → una domanda a Stripe; 10 richieste simultanee su un ordine pagato → rilasciato una volta; pagina scaduta → "canceled"; limite 429 con `Retry-After`; anteprime non toccate.

### Non verificato / limiti (Passo 4.1)

- **Nessuna pagina** usa ancora l'endpoint (arrivano al 4.2 e al 4.3); `/checkout/success` risponde 404 finché non esiste la pagina.
- Stripe reale, browser e telefoni veri, intestazioni dietro il proxy/CDN di produzione (la risposta è `private, no-store`, ma va verificata sull'infrastruttura vera: `CHECKLIST-PRELANCIO.md` 1.5), `Secure` del cookie ospite dietro il proxy.
- Un cliente che ha appena pagato può vedere "non completato" per **al massimo 4 secondi** se una lettura precedente dello stesso ordine è appena avvenuta: la pagina ripete.
- L'indirizzo IP per il limite si legge da `X-Forwarded-For` (falsificabile se il proxy non lo imposta): restano i limiti per ordine e globale. Chi conosce l'id di un ordine (non indovinabile) potrebbe consumarne il budget di richieste.
- Gli effetti in secondo piano si perdono se il processo muore subito dopo la conferma: li riprende il recupero del Passo 5 (come già per gli altri percorsi).
- Rischi residui registrati nella checklist pre-lancio: OrderWorks (1.12), viste di produzione (1.13), metadati concorrenti (2.7), letture di stato e sincronizzazione su più istanze (2.8, 2.9).

## Passo 4.2 – il checkout nuovo (interfaccia), ospiti, indirizzo IP, prezzo

Nessuna dipendenza nuova, nessuna migrazione. Il browser non decide mai un prezzo né un pagamento: chiede il preventivo al server, mostra le sue cifre intere in centesimi e, quando il cliente preme "Paga", rimanda **quel totale** insieme a una chiave di ripetizione; il server ricalcola e crea l'ordine solo se coincide.

### Il flusso della pagina `/checkout` (italiano, testi in `lib/checkout-copy.ts`)

1. **Pagina del server** (`app/checkout/page.tsx`): aperta a tutti, ospiti compresi. Non contiene dati privati (il carrello sta nel browser, le cifre arrivano da `POST /api/checkout/quote`). Legge solo se mostrare il collegamento alla fatturazione (amministratori e membri di organizzazione).
2. **Componente** `components/checkout/HostedCheckout.tsx` + `useServerQuote.ts` + `QuoteSummary.tsx` + `lib/checkout-client.ts` (funzioni pure, provate senza browser):
   - Il carrello salvato nel browser diventa una richiesta valida per lo schema del server (`buildQuoteRequest`: niente `null` dove lo schema li rifiuta — il vecchio checkout li mandava e il nuovo endpoint li avrebbe rifiutati —, quantità 1–50, scala 0,1–5, id prodotto malformato scartato). **Non invia mai `priceMultiplier`** né importi.
   - **Una richiesta per carrello diverso** (firma canonica di carrello + consegna + urgenza): tornare a una scelta già chiesta nei 30 secondi precedenti risponde dalla memoria; una richiesta nuova annulla la vecchia e una risposta vecchia non può sostituire una nuova (contatore di sequenza **e** annullamento della richiesta: due difese, la seconda copre la prima, quindi non sono separabili con una prova dall'esterno); dopo "troppe richieste" la pagina riprova **una volta** dopo la pausa chiesta dal server; tornando alla pagina con il tasto Indietro (pagina ripristinata dalla memoria) il preventivo si richiede di nuovo. Il preventivo **non crea ordini né sessioni**.
   - Carrello letto una volta sola, insieme a urgenza (dal carrello) e consegna (ritiro / spedizione in Italia, ricordata per la sessione): il primo preventivo parte già con i valori giusti, niente richiesta doppia. `CartProvider` ha ora `ready` (la pagina non mostra "carrello vuoto" prima di aver letto il carrello salvato).
   - Il preventivo contiene `shippingOffer` (spedizione disponibile? costo in centesimi): le due scelte si mostrano senza chiedere due volte; se la spedizione non è disponibile la pagina torna al ritiro.
   - **"Paga con carta"**: un blocco nel gestore (anche tre clic nello stesso istante, prima che la pagina si ridisegni) + pulsante disattivato + chiave di ripetizione salvata per la sessione (`sessionStorage`; se bloccata resta in memoria): stesso carrello e stesso totale = **stesso ordine e stessa pagina di pagamento**; totale diverso = nuova chiave. La risposta viene seguita **solo se** è `https://checkout.stripe.com/…` (senza utente/password): qualunque altro indirizzo è un errore. Se il browser non parte entro 15 s il pulsante torna disponibile con una spiegazione.
   - **Ritorno dal "annulla" di Stripe** (`/checkout?canceled=1`): avviso "Hai interrotto il pagamento: non è stato addebitato nulla e il carrello è rimasto com'è", carrello intatto; ripagare con lo stesso carrello riusa l'ordine e la pagina di pagamento ancora aperta. Anche tornando con il tasto Indietro (pagina ripristinata) il pulsante si riattiva.
   - **Errori** (`lib/checkout-client.ts` → `lib/checkout-copy.ts`): ogni codice del server ha una frase e un passo successivo: rete assente (nulla addebitato, riprova), troppe richieste (attesa), articoli non più vendibili (la riga è evidenziata, un pulsante li rimuove dal carrello), colore/opzione non più disponibile (torna al carrello), ordine minimo (con la cifra), prezzo cambiato (nuovo totale da confermare; **non si crea nulla per il vecchio totale**), ordine non più pagabile, troppi tentativi, pagamento online non disponibile, spedizione non disponibile, servizio di pagamento che non risponde (si ripete con la stessa chiave: un solo ordine). Nessuna frase dice "pagato".
3. **Pagina di fatturazione** `/checkout/billing`: la vecchia interfaccia (`components/checkout/LegacyCheckout.tsx`, spostata con `git mv`) per metodi riservati agli amministratori e richieste di preventivo delle organizzazioni. Dietro l'accesso; **senza il modulo della carta** (`cardEnabled` = `isLegacyCardCheckoutEnabled()`, mai in produzione); lo script di Stripe non viene più caricato all'apertura (importato da `@stripe/stripe-js/pure`). Limite: resta in inglese e con le funzioni di prima. `CheckoutForm` e i pacchetti Stripe del browser **non sono stati rimossi** (Passo 6).
4. `/cart`, `/checkout` aperti agli ospiti nel proxy (percorsi esatti: `/cart/x`, `/checkout/billing`, `/customer/*`, `/upload`, `/me`, `/admin` restano dietro l'accesso). Voce "Cart" nell'intestazione e nel menu del telefono anche per chi non ha fatto l'accesso.

### Ospiti e riservatezza dei modelli

Un ospite può preventivare e pagare **solo** i modelli pubblicati dal negozio; un modello di un cliente (anche salvato come "pubblico") e un modello inesistente danno **lo stesso rifiuto** (`ITEM_UNAVAILABLE`, 404, stessa forma, `details.itemIndexes` con la sola posizione nel carrello); un altro cliente è rifiutato allo stesso modo; il proprietario può ordinare il proprio. L'API del modello usata dal carrello risponde 404 a ospiti e altri clienti. **L'upload non è stato toccato** (resta dietro l'accesso); l'**obiettivo futuro** di caricare un primo modello senza registrazione obbligatoria è registrato in `docs/PROGETTO.md` (punto 20), non implementato.

### Indirizzo IP e limiti (`lib/client-ip.ts`)

- **Prima:** si credeva alla prima voce di `X-Forwarded-For` (poi `X-Real-IP`): chi invia l'intestazione sceglie il proprio "indirizzo" a ogni richiesta e non incontra mai un limite per indirizzo (password illimitate per un account — la chiave è `login:<email>:<ip>` —, registrazioni, preventivi e sessioni di pagamento).
- **Ora:** vale solo ciò che scrive un proxy **nostro**. `TRUSTED_PROXY_HOPS=n`: la voce di `X-Forwarded-For` a n posti dalla **fine** (il proxy aggiunge in coda; le voci scritte dal visitatore stanno a sinistra); meno voci di n = nessuna fiducia. `CLIENT_IP_HEADER=<nome>`: solo quell'intestazione, un solo indirizzo, mai ripiego sull'elenco; `x-forwarded-for` e `forwarded` non sono accettati come nome. Valori non indirizzi, elenchi troppo lunghi (> 40 voci o 2000 caratteri), numeri di proxy non interi o > 10 → nessuna fiducia. Porta e parentesi aggiunte da alcuni proxy sono tolte; `::ffff:a.b.c.d` diventa IPv4; **per IPv6 si conta la /64** (una connessione possiede tutti i suoi 2^64 indirizzi). Senza configurazione ogni richiesta è `unknown`. Stessa regola per il registro delle azioni admin e per `lastLoginIp` (null se ignoto).
- **Limiti che non dipendono dall'indirizzo, sempre attivi:** globale del negozio (`checkout:<tipo>:all`), per utente registrato, per ordine (stato: `checkout:status:order:<id>`; pagamenti: tentativi per ordine → `TOO_MANY_ATTEMPTS`), chiave di ripetizione e impronta. Con indirizzo ignoto il contatore per indirizzo del checkout **non viene creato** (diventerebbe un unico contatore condiviso con tetto basso: un proxy mal configurato bloccherebbe tutti a 120 preventivi); login e registrazione restano per indirizzo (`unknown` condiviso: fallisce chiuso, ma un aggressore può bloccare l'accesso a un account per 15 minuti — motivo per cui il controllo ambiente admin segnala `TRUSTED_PROXY_HOPS`/`CLIENT_IP_HEADER` mancanti come **errore** in produzione).
- Non coperto: un attacco distribuito con indirizzi veri diversi contro un solo account (5 tentativi per indirizzo); non esiste un tetto per account indipendente dall'indirizzo (sceglierlo vuol dire poter bloccare le vittime: decisione aperta).

### Prezzo: il moltiplicatore e i prodotti (`lib/price-multiplier.ts`)

- Il server **non legge più** `priceMultiplier` dal carrello (lo schema lo accetta per non rifiutare carrelli vecchi, ma lo ignora). Il moltiplicatore viene da: la tabella delle tolleranze (0,94 / 1 / 1,08 / 1,16, usata anche dalla pagina del preventivo istantaneo) oppure, per un prodotto, dal prodotto nel database (moltiplicatore del prodotto × moltiplicatore della variante di colore scelta, limitati a 0,1–5; valori danneggiati nel database = nessun sovrapprezzo).
- Un prodotto deve **esistere, essere in vendita e appartenere a quel modello** (`ITEM_UNAVAILABLE`); un colore non offerto dal prodotto è rifiutato (`OPTION_UNAVAILABLE`, prima era prezzato senza sovrapprezzo); materiale, finitura e scala sono quelli **del prodotto** (il prezzo di un prodotto non ne dipende: prima il browser poteva scegliere un altro materiale al prezzo del PLA); riempimento, dimensioni di destinazione e tolleranza del carrello sono ignorati. Lo stesso valeva per il vecchio checkout, che usa lo stesso calcolo. Anche gli effetti sull'inventario dopo il pagamento (usano l'id prodotto) ora ricevono solo id convalidati.
- **Snapshot dei 72 scenari: cambiato di proposito.** Lo scenario che fissava il comportamento vulnerabile ("moltiplicatore 0,5 dal browser → totale 20,15") è rinominato e ora vale 46,75; due errori di dati del modello/parte, prima 500 con un messaggio che nominava l'id interno, sono ora 422 (`ITEM_NOT_PRICEABLE`, messaggio generico) e 400. Tutti gli altri scenari sono identici.
- **Resta non vincolante** l'anteprima `POST /api/models/{id}/quote` (preventivo istantaneo): legge ancora il moltiplicatore dal browser, ma non crea né addebita nulla; il carrello mostra ancora un calcolo locale fino al Passo 4.4.

### Errori strutturati

Ogni regola del preventivo ha un codice (`CheckoutQuoteError`): `ITEM_UNAVAILABLE` (con `details.itemIndexes`/`itemIndex`), `OPTION_UNAVAILABLE`, `COLOR_REQUIRED`, `COLOR_INVALID`, `COLOR_NOT_ALLOWED`, `COLOR_UNAVAILABLE`, `ITEM_NOT_PRICEABLE`, `MINIMUM_ORDER` (con `details.minimumCents` e `currency`), `TOTAL_INVALID`, più quelli di `session` già elencati. Vedi `docs/mobile-api-contracts.md`.

### Verifiche eseguite (Passo 4.2)

- **Test automatici nuovi:** `tests/security/client-ip.sec.ts` (11: login e preventivi non aggirabili con indirizzi falsificati, intestazioni del visitatore ignorate, `CLIENT_IP_HEADER`, limiti globale/per ordine/globale dello stato con indirizzo ignoto, registro admin, controllo ambiente), `tests/security/price-multiplier.sec.ts` (11), `tests/security/guest-checkout.sec.ts` (7), `tests/client-ip.test.ts` (10), `tests/checkout-client.test.ts` (14: richiesta valida per lo schema del server, nessun prezzo inviato, chiave di ripetizione, ogni codice di errore, indirizzi di Stripe, risposte non valide, frasi senza "pagato" e senza promessa di recupero registrandosi), `tests/public-asset-proxy.test.ts` aggiornato (solo i percorsi esatti `/cart`, `/checkout`, `/checkout/success` sono pubblici), snapshot dei 72 scenari rigenerato di proposito.
- **Prove di mutazione (65, tutte rilevate):** 18 sull'indirizzo (prima voce creduta, intestazioni non configurate, ripiego sull'elenco, nessuna validazione, IPv6 per indirizzo, contatori globali/per ordine tolti, controllo ambiente muto…), 16 sul prezzo (moltiplicatore del browser, prodotto spento/di altro modello/inesistente, variante non offerta, materiale/finitura/scala/riempimento/tolleranza dal carrello, tetti e valori negativi, tabella cambiata…), 10 su ospiti e percorsi pubblici (percorsi aperti di troppo, ospiti che vedono ogni modello, dettagli degli errori persi, spedizione sempre offerta…), 21 sul lato browser (priceMultiplier inviato, chiave ignora il totale o è sempre nuova, qualunque URL seguito, importo atteso non inviato, indicazioni degli errori perse, avviso che promette recupero registrandosi…). **Una non è coperta da un test automatico di sicurezza:** il collegamento "Cart" per gli ospiti nell'intestazione (ora coperto da `checkout.responsive.spec.ts`).
- **Regressione:** `lint`, `typecheck`, `build` OK; suite di sicurezza **262/262** (0 `todo`); `npm test` 251 (249 superati, solo i 2 fallimenti preesistenti: marchio r3Dr e percorso dei repository fratelli); `test:api` 7/7; `test:contracts` 14/14; S1–S7 e il Passo 3 invariati.
- **Server reale** (`next start` in produzione, Stripe simulato a livello HTTP con indirizzo `https://checkout.stripe.com/…`, Chromium con telefono emulato 393×851 e desktop, dati fittizi): **62 verifiche su 62** — vedi `docs/CHECKLIST-PRELANCIO.md`, registro delle verifiche automatiche.
- **Test automatico su desktop e smartphone** (requisito permanente): `playwright.config.ts` ha i progetti `chromium`, `mobile` (393×727) e `mobile-small` (360×640); `tests/e2e/checkout.responsive.spec.ts` (8 scenari: collegamento al carrello per gli ospiti, carrello vuoto, preventivo che sta nello schermo con nomi lunghi, bersagli ≥ 44 px, scelta della consegna con un tocco, tastiera sul desktop, tre tocchi = una richiesta, errori, ritorno da "annulla"): **22 superati, 2 saltati** (tastiera: solo desktop). Provato che il test sa fallire (nome senza a-capo e pulsante basso: 9 fallimenti su 3 formati).
- **Trovato dalle prove e corretto:** (1) il carrello nel browser veniva scritto vuoto prima di essere letto (vedi `docs/PROGETTO.md` punto 23c); (2) le voci del menu del telefono erano alte 38 px (ora 44 px); (3) Stripe.js caricato all'importazione nella pagina di fatturazione.

### Non verificato / limiti (Passo 4.2)

- **Non è stato provato con Stripe reale**, con **Safari/iOS** (nell'ambiente c'è solo Chromium: nessun motore WebKit), con **telefoni veri** (tocco, gesti, tastiera mobile, barra degli indirizzi), né con Apple/Google Pay. Il comportamento del tasto Indietro dalla pagina di Stripe con la pagina ripristinata dalla memoria del browser (`pageshow`) è scritto ma **non osservato** in un browser vero. Tutto questo è in `docs/CHECKLIST-PRELANCIO.md` (1.3, 1.4, 1.16), "da eseguire".
- **`/checkout/success` non esiste ancora** (Passo 4.3): finché non c'è, il ritorno da Stripe e il collegamento "Controlla lo stato dell'ordine" arrivano a una pagina inesistente. `HOSTED_CHECKOUT_ENABLED` deve restare spento in produzione.
- Il carrello continua a mostrare un calcolo locale (Passo 4.4): il totale vincolante è quello del checkout. Il carrello non è ancora stato esaminato per la larghezza su telefoni reali.
- I limiti di partenza (300 globale per tipo e finestra, 120 preventivi per indirizzo) non sono tarati sul traffico reale (checklist 2.10).
- Fatturazione/organizzazioni: vedi sopra; in inglese, senza carta.
- Pagine **esistenti** non toccate e **misurate soltanto** (scorrimento orizzontale a 360 px di `/upload` e `/settings/profile`, intestazione con controlli alti 36 px, errore JavaScript su `/models/[id]` e `/products/[id]` con dati fittizi): `docs/PROGETTO.md`, punto 19. Audit completo da pianificare.
- Il ritiro e i testi non sono stati confermati dal negozio; mancano i riferimenti legali (checklist 1.14, 1.15).

## Passo 4.2-bis – verifica di compatibilità tra carrello, preventivo e Stripe Checkout

Punto di controllo richiesto prima del 4.3. Dettagli, matrice completa, anomalie e proposte: **`docs/VERIFICA-CARRELLO-PREVENTIVO-STRIPE.md`**. Nessuna logica commerciale modificata.

- **Risultato economico:** preventivo = ordine = importo inviato a Stripe, al centesimo e in euro, in **18 carrelli su 18** (in-process) e in **36 esecuzioni su 36** nel browser (desktop e telefono emulato, attraverso `/cart` → «Checkout» → `/checkout` → «Paga» → Stripe), con sconti, IVA inclusa/esclusa/nessuna, spedizione/ritiro/gratuita, urgenza, parti, prezzo fisso, saldo e prodotti. Sessione Stripe legata all'ordine e al tentativo in ogni caso.
- **Nuovi test:** `tests/security/checkout-consistency.sec.ts` (+ `_checkout-scenarios.ts`), `tests/real-run/checkout-matrix.ts` (+ `fake-stripe-http-preload.js`, che registra il modulo realmente inviato all'SDK), un test e2e (carrello intatto dopo errori); 13 prove di mutazione rilevate.
- **Anomalie trovate (da decidere):** A1 la stima del carrello differisce dal preventivo (**bloccante**: proposta di mostrare nel carrello le cifre del server, anticipando la parte minima del 4.4); A2 la parte di un modello a più parti è addebitata circa la metà per la dimensione in mm inviata dalla pagina (**bloccante**: proposta di non inviarla e ricavarla dal server); A3 valuta incorporata alla build e non passata dal `Dockerfile` (carrello in «$»: proposta di configurazione); A4 materiale/finitura come testo libero; A5 nessun minimo dopo la scala/importo minimo di Stripe; A6 stima della pagina del prodotto; A8 nessun controllo del volume di stampa (requisito tecnico permanente della stampante, `docs/PROGETTO.md`).
- **Non provato (Stripe reale in modalità test):** parametri accettati, importo minimo, righe e totale mostrati dalla pagina ospitata (checklist 1.20); ritorno alla pagina di conferma (Passo 4.3).
