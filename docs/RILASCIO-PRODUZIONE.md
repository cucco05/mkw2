# Rilascio in produzione degli ordini — passo 4.6, S4

> Stato: **implementato e provato con servizi simulati** (Stripe simulato, PrintLab e StockWorks finti come server HTTP locali, database di prova). **Non** provato con Stripe reale, PrintLab/StockWorks reali, stampanti reali, telefoni veri o un operatore reale: l'elenco è in fondo (§13) e in `docs/CHECKLIST-PRELANCIO.md`. Il checkout **non è dichiarato pronto per la produzione commerciale**: `acknowledgeUnverified` esiste ancora fino a S6.
> Numeri e registro delle prove: `docs/VERIFICA-4.6.md`, sezione «S4».

## 1. Il problema

Ogni checkout abbandonato crea un ordine `awaiting_payment`. Prima di S4 un ordine poteva essere **assegnato a una stampante, inviato a PrintLab, avanzato o contato come lavoro in coda** da percorsi che guardavano solo «pagato oppure autorizzato» (`isProductionEligible`) e che **non vedevano i blocchi di pagamento** (pagamento in revisione, in conferma, pagina Stripe ancora aperta), oppure non guardavano nulla (`printlab-link`). Inoltre:

- un segnale di PrintLab (callback o collegamento) poteva trasformare in `queued`/`printing`/`completed` un ordine non pagato;
- l'approvatore di un'organizzazione poteva riportare in coda un ordine `completed` o `cancelled`;
- il consumo di materiale (StockWorks) non controllava il pagamento e «già consumato» non era atomico;
- una chiamata a PrintLab/StockWorks con esito sconosciuto (timeout, risposta persa) poteva essere ripetuta;
- un ordine già inviato a PrintLab poteva essere eliminato, lasciando un lavoro orfano.

Obiettivo di S4: **una sola regola**, applicata **nel punto in cui l'effetto avviene** (non solo nelle viste), **rivalutata sotto blocco di riga** subito prima di scrivere o di chiamare un servizio esterno, con prove sulle rotte reali. Nessuna modifica ai prezzi, all'IVA o alle regole commerciali; nessuna migrazione; nessuna dipendenza nuova.

## 2. La regola unica

`releaseDecision(fatti)` in `lib/order-payment-policy.ts`: **pura** (nessun database, nessuna rete, nessun orologio se non quello passato). I fatti sono obbligatori nel tipo (`RELEASE_FACTS_SELECT` li carica): chi dimentica i tentativi di pagamento o il motivo di revisione non compila.

Precedenza (vince la prima riga che si applica):

| # | Condizione | Stato | Autorizzabile dall'admin |
|---|---|---|---|
| 1 | `paymentReviewReason` impostato e diverso da `external_order` (**qualunque** codice, anche sconosciuto) | `payment_hold` | **no** |
| 2 | `external_order` + il registro `metadata.paymentReview` contiene un problema di denaro trovato dopo | `payment_hold` | **no** |
| 3 | `paymentStatus = processing` oppure un tentativo `processing` | `payment_processing` | **no** |
| 4 | ordine esterno senza autorizzazione esplicita | `external_review` | sì (motivo scritto) |
| 4b | ordine esterno autorizzato **ma con una pagina Stripe ancora aperta** | `payment_active` | **no** |
| 5 | pagamento verificato **e** con la prova che solo il server scrive | `released` | — |
| 6 | pagina/prenotazione Stripe `creating`/`open` ancora valida (scadenza + 10 min) su ordine non pagato con prova | `payment_active` | **no** |
| 7 | `metadata.productionAuthorization.authorized = true` con `by` | `released` (autorizzazione) | — |
| 8 | lo stato dice «pagato/gratuito» ma **manca la prova** | `payment_unproven` | sì |
| 9 | tutto il resto (`pending`, `requires_capture`, `quote`, `canceled`…, un riferimento Stripe digitato) | `payment_pending` | sì |

**Tre basi di rilascio, sempre distinte** (nell'audit, nei log, nelle schermate): pagamento verificato (`stripe_verified`, `paypal_verified`, `free_order`), pagamento manuale documentato (`manual_payment`) e autorizzazione dell'amministratore (`admin_authorization`).

**`paymentStatus = paid` da solo non è una prova.** La prova è ciò che scrive il server dopo aver controllato il denaro: un riferimento Stripe (`stripePaymentIntentId` o `stripeInvoiceId`) **insieme a** `paidAt`, a un tentativo `paid` o al record Stripe nei metadati; oppure una cattura PayPal verificata; oppure `metadata.manualPayment` completo (`by`, `at`, `reason`, `method`); oppure il totale a zero. Un riferimento Stripe digitato da una persona, un evento PrintLab o una parola di stato **non rilasciano nulla**.

**Un'autorizzazione non prevale mai** su un pagamento tenuto, in conferma o ancora aperto. Per questi casi si risolve prima il pagamento (`payment-hold`); un'autorizzazione è la decisione di una persona di produrre **senza** un pagamento verificato, non una scorciatoia sopra un denaro che potrebbe arrivare.

Estensioni pure: `isReleasedToProduction`, `releaseView` (dati semplici per le schermate), `describeRelease` (testi), `checkManualTransition` e `gateAutomaticStatus` (costruite sopra la decisione; i codici `PAYMENT_NOT_VERIFIED`, `PAYMENT_UNPROVEN`, `PAYMENT_PROCESSING`, `PAYMENT_ACTIVE`, `PAYMENT_ON_HOLD`, `EXTERNAL_ORDER_NOT_AUTHORIZED`), `releasedOrderWhere` (prefiltro Prisma, §3). `lib/payment-review-reasons.ts` dà il testo di ogni codice di revisione (riusabile da S6).

`isProductionEligible` **resta** soltanto per `lib/reprint.ts` (può un **cliente** chiedere la ristampa di un ordine che è stato pagato? Non è un'azione sulla produzione). Un test statico ne vieta l'uso altrove.

## 3. Il prefiltro Prisma `releasedOrderWhere`

Serve a **scegliere** ordini (coda automatica, pianificatori), non a **permettere** un effetto. Un test (`production-release-parity.sec.ts`) lo confronta con la regola su una matrice di stati e su **400 combinazioni casuali** (seme fisso) in un database vero:

- non ammette mai un ordine che la regola rifiuta, tranne **un** caso dichiarato: un ordine esterno autorizzato con un problema di denaro trovato dopo e scritto **solo** nel registro `paymentReview` (il prefiltro non sa leggerlo); e i campi di prova fatti di soli spazi (Prisma non sa fare `trim` dentro un JSON);
- non lascia fuori un ordine che la regola rilascia (spelling canonico dello stato).

Per questo ogni effetto **rivaluta con `releaseDecision` sotto blocco**: il prefiltro è solo una scrematura.

## 4. Come si applica: tre schemi (`lib/production-release.ts`)

1. **Effetti solo-database** (stato, stampante, approvazioni, sincronizzazione OrderWorks): `withReleaseLock(ordine, azione, fn)` = una transazione, `SELECT … FOR UPDATE` sulla riga (**lo stesso blocco** di `payment-sync` e `payment-hold`: il pagamento che si assesta e l'operazione si decidono una dopo l'altra), rilettura fresca dell'ordine e dei tentativi, decisione, scrittura con lo stesso `tx`, **audit come ultima istruzione** (ordine dei blocchi: riga d'ordine → catena di audit). Nessuna chiamata di rete dentro la transazione. Se l'ordine non è rilasciato: `409 { error, code, releaseState }` e **non si scrive nulla** (riga, tentativi, audit identici; PrintLab e StockWorks non sentono niente).
2. **Effetti esterni** (invio a PrintLab, consumo di materiale in StockWorks): registro di intento prima della chiamata, ri-verifica sotto blocco **prima di ogni riga**, timeout, classificazione dell'esito, riconciliazione per presenza (§5).
3. **Segnali tecnici** (callback di PrintLab, collegamento di un lavoro PrintLab): i **metadati si registrano sempre** (la realtà fisica resta visibile), lo **stato cambia solo se l'ordine è rilasciato** e solo per gli stati PrintLab noti (`started`, `completed`, `failed`, `cancelled`, `submit_failed`); la risposta resta 200 (PrintLab non deve riprovare). Un valore sconosciuto non trasforma più `awaiting_*` in `queued`.

## 5. Operazioni esterne con esito sconosciuto

Una richiesta può finire senza dire se l'altra parte ha fatto qualcosa: risposta persa, connessione interrotta dopo l'invio, timeout, 5xx dopo aver lavorato. Ripetere potrebbe stampare due volte o togliere il materiale due volte. Perciò (`lib/external-effects.ts`, registro in `metadata.externalEffects`, una voce per riga PrintLab `printlab:item:<id>` e per riga di consumo `stockworks:<riferimento>:<articolo>:<grammi>:<occorrenza>`):

1. **intento** scritto **prima** della chiamata, sotto blocco, con una prenotazione (claim) di 5 minuti che chi lavora ancora rinnova;
2. la fine della chiamata è **classificata**: `not_sent` (la richiesta non è partita: connessione rifiutata, nome non risolto, porta vietata), `rejected` (il servizio ha risposto 4xx: non ha fatto nulla), `confirmed` (ha risposto con il record), `uncertain` (tutto il resto: timeout, reset, 5xx, 409/408, risposta che non è un record);
3. un intento senza esito (processo morto, claim scaduto) **vale `uncertain`**; metadati azzerati (account cancellato) = ogni effetto parte `uncertain` (`metadata_lost`);
4. **da `uncertain` non c'è alcuna via automatica verso «invia di nuovo»**, nemmeno a claim scaduto o dopo un riavvio. Se ne esce **solo con la prova che l'effetto esiste**: il record è trovato sul sistema esterno (riconciliazione **per presenza**: PrintLab, un lavoro con la chiave di idempotenza dell'articolo; StockWorks, un movimento con riferimento e firma), oppure un amministratore indica l'identificativo del record e **il server lo verifica** sul sistema esterno (`POST /api/admin/orders/<id>/external-effects`). L'**assenza** in una ricerca non è una prova (il servizio può essere in ritardo, non elencare, essere irraggiungibile); una **dichiarazione** dell'amministratore («non è successo, riprova») non è una prova. **Quell'azione non esiste**: lo schema della rotta è `.strict()` e il solo campo di decisione è l'identificativo di un record da verificare. Senza prova: `409 NO_RELIABLE_PROOF`, lo stato resta incerto, nessun nuovo tentativo parte, l'amministratore lo vede (riquadro «Production release»).
5. **Non si dichiara «exactly once»**: la garanzia è «**al più un tentativo per intento, mai ripetuto mentre l'esito è sconosciuto**». Che PrintLab onori le chiavi di idempotenza non è verificabile da questo repository: non ci si fa affidamento.

La prova distingue, in test separati: errore **prima dell'invio**, errore **dopo la ricezione**, **risposta persa**, **timeout**, **ripetizione concorrente**, **riavvio del processo** (intento rimasto nel database).

## 6. Un blocco che arriva dopo l'invio a PrintLab

Un pagamento può essere messo in revisione (disputa, doppio pagamento, regressione di stato…) quando l'ordine è già `queued` e **già inviato** a PrintLab. Il comportamento di S4:

- il blocco **ferma ogni avanzamento e ogni nuovo effetto**: cambio di stato, assegnazione, nuovo invio, consumo di materiale, coda automatica;
- i segnali di PrintLab continuano a essere **registrati** nei metadati, ma non cambiano lo stato;
- un blocco che arriva **durante** una chiamata: la voce del registro è marcata `blockedAfterSend`; **non si annulla nulla e nessun comando va a PrintLab o a una stampante**;
- l'ordine compare in «Not in production» con il motivo, con «PrintLab reported "…"» e con ciò che è già andato in produzione;
- se il blocco viene poi risolto (`accepted`), l'ordine torna rilasciato ma **non viene mosso da solo**: il riquadro dice «PrintLab reported X, the order is Y» e l'amministratore allinea lo stato a mano (solo da quel momento il materiale viene consumato).

**Mai** un annullamento automatico. Fermare un lavoro avviato fisicamente è una decisione di una persona (pausa/stop da `bambu-view/job`, che per le regole del progetto richiedono l'approvazione esplicita dell'operatore). Non esiste ancora una notifica all'amministratore quando compare un blocco su un ordine in lavorazione (Passo 5/6).

## 7. Richieste da altri siti (CSRF) e callback

Le rotte di amministrazione che modificano **ordini, produzione, stampanti, macchine, controlli fisici, movimenti di magazzino e deroghe**, più l'approvazione di organizzazione, rifiutano una richiesta che non viene da questo sito (`rejectCrossOrigin`, che riusa `isSameOriginRequest`): `403 INVALID_ORIGIN`, **prima** di leggere o scrivere qualsiasi cosa. `SameSite=Lax` da solo non basta. Sono rifiutate anche le richieste che non dicono da dove vengono.

I **callback con segreto o firma** (PrintLab `POST /api/printlab/jobs/<id>`, webhook Stripe, OrderWorks in ingresso) sono cosa diversa: nessun cookie, nessun controllo di origine; un test statico verifica che non usino la sessione né il controllo di origine, e che continuino a verificare il loro segreto.

**Non esteso** (dichiarato): le altre rotte admin che non riguardano ordini/produzione (utenti, impostazioni del sito, backup/ripristino, catalogo, modelli, profili di prezzo…) non hanno ancora il controllo di origine.

## 8. Ordini già inviati alla produzione

`DELETE /api/admin/orders/<id>` e `DELETE /api/admin/orderworks/jobs/<id>` (che elimina anche gli ordini collegati) rifiutano con `409 ORDER_HAS_PRODUCTION_JOB` quando esiste un invio produttivo registrato, un lavoro PrintLab, un esito incerto, un intento in volo, consumo di materiale o uno stato di produzione avviata: l'ordine si **conserva** (nessun lavoro orfano). Si usa l'annullamento esplicito: `status = cancelled` con `cancellationReason` di almeno 10 caratteri (`409 CANCELLATION_REASON_REQUIRED` senza), che resta sull'ordine con chi, quando e perché, e lascia un evento di audit. **Nulla viene fermato a PrintLab o su una stampante da qui**: prima una persona ferma/verifica il lavoro in PrintLab, poi annulla l'ordine.

## 9. Collegare a mano un PaymentIntent (`stripe-attach`)

Solo `admin`, origine del sito, motivo scritto (≥ 10 caratteri), audit nella stessa transazione. Prima di scrivere **qualsiasi cosa** la rotta rilegge il PaymentIntent da Stripe (`lib/stripe-attach.ts`) e verifica: identità (l'id restituito è quello chiesto), incasso (`succeeded` con importo incassato uguale al totale), valuta, nessun riutilizzo (nessun altro ordine o tentativo lo usa), stato dell'ordine (non annullato, non in revisione, non già pagato, senza pagine del checkout ospitato) e **l'associazione**: il PaymentIntent deve portare nei **suoi** metadati Stripe `orderId` uguale all'id di **questo** ordine (e, se c'è `attemptId`, deve essere un tentativo di quest'ordine). **L'associazione non si dimostra con nient'altro**: stesso cliente Stripe, stessa e-mail, stesso utente, stesso importo o data vicina non valgono, né da soli né insieme. Se il legame specifico non è verificabile: `409` con l'elenco dei controlli falliti, nessun legame, l'ordine resta non pagato, **nessun aggiramento amministrativo**. Un pagamento fuori da Stripe (contanti, bonifico) è un'altra cosa, con un percorso suo e tracciato (`metadata.manualPayment`): `stripe-attach` non lo produce mai. Il legame, anche riuscito, **non rilascia da solo**: lo stato di pagato lo scrive la verifica di `payment-sync`.

## 10. Integrità dei metadati

Le rotte che riscrivevano l'intero JSON `metadata` letto prima (`packing-checklist`, `shipping`, `slicer-stats`, `slicer-profile`, `stripe-attach`, tre scritture del checkout legacy) potevano **cancellare** i marcatori di idempotenza (`stockworksConsumedAt`, claim, registro) e l'autorizzazione. Ora passano da `updateOrderMetadata` (blocco di riga + rilettura), e `RESERVED_ORDER_METADATA_KEYS` impedisce a un servizio esterno o a un cliente di falsificare o azzerare le chiavi riservate (`productionAuthorization`, `externalEffects`, `printLabSubmissions`, `lastPrintLabSubmission`, `stockworksConsumedAt`, `orgApproval`…).

**Privacy (cancellazione dell'account).** `lib/privacy.ts` **non è stato modificato** (cambierebbe il sistema privacy): azzera **tutti** i metadati dell'ordine (`metadata = NULL`) e lascia `shippingAddress`; così si perdono l'autorizzazione, i claim e il registro. La difesa lato produzione non richiede di toccare la privacy: un ordine con metadati azzerati ha **esiti sconosciuti** (`metadata_lost`) ⇒ nessun invio né consumo senza riconciliazione col sistema esterno, nessun nuovo tentativo per dichiarazione. **Proposta separata (da approvare):** far conservare alla cancellazione i soli marcatori operativi.

## 11. Viste e interfaccia amministratore

- **Coda** (`getProductionSnapshot`): contiene **solo ordini rilasciati**; posizione, tempo stimato e `queueHours` non contano gli altri. Gli ordini trattenuti compaiono in `notReleased` **solo** con `includeRelease: true` (pagine e API admin): stato, testo, motivo di revisione, «PrintLab reported», cosa è già andato in produzione, esiti incerti. Un ordine pagato e rilasciato ma ancora `awaiting_*` è «waiting for an administrator».
- **Tempo di consegna mostrato ai clienti** (`lead-time-estimator`): **si accorcia**, perché non conta più i checkout abbandonati (nessun effetto sul prezzo).
- **Pianificatori**: quelli che guardano **avanti** (`batch-optimization`, previsioni StockWorks) compongono `releasedOrderWhere()` con il loro filtro; quelli che guardano **indietro** (storia flotta, rapporto sprechi) non contano come stampato un ordine ancora `awaiting_*`.
- **Nessuna fuga ai clienti**: `release`, `notReleased`, `paymentReviewReason`, il registro delle chiamate e l'autorizzazione non compaiono in nessuna risposta cliente (API ordine, dettaglio produzione, snapshot senza `includeRelease`); provato per ogni stato.
- **Pagina ordine admin**: riquadro «Production release» (stato, base, chi/quando/perché dell'autorizzazione, pagamento manuale, codice di revisione, «PrintLab reported», registro delle chiamate con il modulo «Confirm with the PrintLab/StockWorks record», ciò che è già andato in produzione); `OrderStatusControl` (stato attuale, nota di rilascio, pulsante «Move to queue», richiesta di autorizzazione **in pagina** con motivo di almeno 10 caratteri — solo per `PAYMENT_NOT_VERIFIED`/`PAYMENT_UNPROVEN`/`EXTERNAL_ORDER_NOT_AUTHORIZED` e solo per l'amministratore; per blocchi, conferme in corso e pagine aperte nessun modulo, solo il messaggio); `PrinterAssignmentPanel`, `PrintLabSubmitButton`, `PrintLabLinkPanel` si disattivano e spiegano perché. **Il server resta l'autorità**: i pulsanti disattivati sono una spiegazione, non una protezione. `OrderStatusBadge` dice «Awaiting payment»/«Awaiting review» invece di «Queued».
- Layout: un'unica interfaccia responsive; bersagli ≥ 44 px, nessuno scorrimento orizzontale, nessun testo troncato (prove su `chromium` 1280×720, `mobile` 393×851, `mobile-small` 360×640: **emulazione**, non telefoni veri).

## 12. Limiti noti e cose non coperte (nessuna presentata come risolta)

1. **Ordini non ospitati con un motivo di revisione** (carta legacy spenta in produzione, oppure collegati con `stripe-attach`): `payment-hold` rifiuta gli ordini senza tentativi (`NOT_A_HOSTED_ORDER`) e nessun altro percorso azzera il motivo ⇒ l'ordine **resta bloccato**. È la direzione sicura ma è un vicolo cieco operativo: la procedura eccezionale è un progetto separato da sottoporre (vincolo V1).
2. **Contestazione (`dispute`) su un ordine già segnalato**: `payment-sync` non la registra (richiede la colonna vuota); correzione proposta per S6.
3. **Tentativo `processing` rimasto su un ordine pagato**: `decidePaymentUpdate` non lo chiude mai; con la sola carta non si verifica, con metodi asincroni diventerebbe un blocco permanente; da sistemare in S6 prima di abilitarli.
4. **Rimborso totale**: non blocca (resta `paid` e rilasciato). `payment-sync` può copiare `refundedCents` da un addebito *duplicato* e un falso positivo fermerebbe un ordine legittimo. Proposta per il Passo 5.
5. **Nessuna notifica** all'amministratore quando un blocco compare su un ordine già in lavorazione; `recoverPostPaymentEffects` non ha chiamanti in produzione (Passo 5); l'effetto post-pagamento `inventory` (scorte dei prodotti pronti) **non** è condizionato al rilascio (è una prenotazione di magazzino per un pagamento reale e non verrebbe mai ripetuto).
6. **Statistiche non operative** (`admin/analytics`, `demand-forecasting`, `creator-quality`, `lib/admin/queries`) contano ancora ordini non pagati.
7. **Sincronizzazione OrderWorks `pending → queued`**: una questione di direzione, non di rilascio; invariata.
8. **Controllo di origine non esteso** alle altre rotte admin (§7).
9. `scripts/hold-unpaid-orders.js` mantiene la vecchia nozione (più larga) e si limita a retrocedere; `payment-hold` ha ancora `acknowledgeUnverified` fino a S6; `lib/reprint.ts` usa ancora `isProductionEligible`.
10. **Consumo parziale in StockWorks**: se un errore interrompe i movimenti di un ordine, il consumo può restare parziale; il registro lo rende visibile (una voce per riga) e la riga incerta non viene ripetuta; la deduplica per riga con riferimenti per riga cambierebbe i riferimenti scritti in StockWorks e non è provabile qui.
11. **Privacy**: vedi §10 (non modificata, segnalata).
12. Un **pagamento PayPal verificato dal server** è stato aggiunto come quarta base di prova (differenza dal piano).

## 13. Cosa è simulato e cosa va verificato con servizi reali

Simulato: Stripe (a livello di SDK/HTTP finto), PrintLab e StockWorks (server HTTP locali che contano le richieste, registrano lavori/movimenti e possono rifiutare, perdere la risposta, andare in timeout), database di prova locale, browser Chromium con emulazione di telefono.

**Da verificare con servizi reali** (righe aperte in `docs/CHECKLIST-PRELANCIO.md`): che PrintLab **onori le chiavi di idempotenza** e che il suo elenco lavori/`GET /api/jobs/<id>` si comporti come assunto dalla riconciliazione; che i movimenti StockWorks siano leggibili per riferimento; Stripe reale in modalità test (collegamento di un PaymentIntent con `metadata.orderId`, dispute reali); un iPhone con Safari e un Android veri sulle nuove schermate; un operatore reale che usi il riquadro «Production release», l'autorizzazione in pagina e il modulo di conferma.

## 14. Come riprodurre le prove

```
npx tsc --noEmit && npm run lint && npm test && npm run test:api && npm run test:contracts
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest npm run test:security    # non lanciare due prove sul database insieme
CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR npm run build
# server reale su dati fittizi, con PrintLab e StockWorks finti avviati dallo script:
SEC_TEST_DATABASE_URL=… node --import tsx tests/real-run/production-release.ts
# browser (seed dedicata + server di produzione sul database di prova):
SEC_TEST_DATABASE_URL=… E2E_RELEASE_FIXTURE=/tmp/release.json node --import tsx tests/e2e/seed-production-release.ts
E2E_BASE_URL=… E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium E2E_RELEASE_FIXTURE=/tmp/release.json npx playwright test tests/e2e/production-release.responsive.spec.ts
```

File delle prove: `tests/production-release.test.ts` (regola pura), `tests/external-effects.test.ts` (registro e classificazione), `tests/production-release-guards.test.ts` (guardie sul sorgente), `tests/security/production-release*.sec.ts` (matrice di stati, effetti esterni, rotte, viste, parità, caso «blocco dopo l'invio»), `tests/security/_release-fixtures.ts` e `_fake-services.ts` (servizi finti), `tests/real-run/production-release.ts`, `tests/e2e/production-release.responsive.spec.ts`.
