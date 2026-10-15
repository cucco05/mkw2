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
| 2 | Ordine in attesa + sessione Stripe; endpoint `quote` e `session`; tariffa di spedizione da configurazione; limitazione richieste; guardia fiscale in produzione; token ospite | **Completato** (vedi sotto) |
| 3 | Webhook per le sessioni, verifica unica (anche sul percorso PaymentIntent), lettura Stripe fuori transazione, avvio produzione una sola volta; chiusura degli ordini non pagati scaduti | Da autorizzare |
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
