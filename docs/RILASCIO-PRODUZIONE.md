# Rilascio in produzione degli ordini — passo 4.6, S4 e S6a

> Stato: **implementato e provato con servizi simulati** (Stripe simulato, PrintLab e StockWorks finti come server HTTP locali, database di prova). **Non** provato con Stripe reale (nemmeno in modalità test), PayPal, PrintLab/StockWorks reali, stampanti reali, telefoni veri o un operatore reale: l'elenco è in fondo (§13) e in `docs/CHECKLIST-PRELANCIO.md`. Il checkout **non è dichiarato pronto per la produzione commerciale**: la scorciatoia `acknowledgeUnverified` (rischio **F01**) è stata **tolta** dal pacchetto P4-0 (§15.11), ma restano aperti e bloccanti il resto di P4 (`payment-hold` verificato per motivo: F02, F03, F12), R1 e il rimborso dall'app non governato (pacchetto P5, non eseguito).
> S6a (§15) aggiunge a S4: rimborsi nella decisione di produzione, blocco durante un rimborso, revisione finanziaria delle autorizzazioni, incassi attestati e credito commerciale, igiene dei dati di pagamento. Le due migrazioni additive di S6a (§16) sono state applicate **solo a database di prova isolati**.
> Numeri e registro delle prove: `docs/VERIFICA-4.6.md`, sezioni «S4» e «S6a».

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
| 2b | **(S6a)** esiste una **operazione di rimborso che blocca** (§15.2) | `payment_refund_pending` | **no** |
| 3 | `paymentStatus = processing` oppure un tentativo `processing` | `payment_processing` | **no** |
| 4 | ordine esterno senza autorizzazione **valida** | `external_review` | sì (motivo scritto) |
| 4b | ordine esterno autorizzato **ma con una pagina Stripe ancora aperta** | `payment_active` | **no** |
| 5 | pagamento verificato **e** con la prova che solo il server scrive (per un pagamento Stripe: **nessun rimborso**, `refundedCents = 0`, S6a) | `released` | — |
| 6 | pagina/prenotazione Stripe `creating`/`open` ancora valida (scadenza + 10 min) su ordine non pagato con prova | `payment_active` | **no** |
| 7 | `metadata.productionAuthorization` **valida**: `authorized = true`, `by` e la **revisione finanziaria** registrata uguale a quella dell'ordine (§15.3); tipo `exceptional` o `commercial_credit`. Il motivo scritto (≥ 10 caratteri) si richiede **alla concessione**, per ogni autorizzazione | `released` (autorizzazione / credito) | — |
| 7b | **(S6a)** la prova Stripe è decaduta perché una parte del pagamento è stata rimborsata (`refundedCents > 0`) | `payment_refunded` | sì (motivo scritto) |
| 8 | lo stato dice «pagato/gratuito» ma **manca la prova** | `payment_unproven` | sì |
| 9 | tutto il resto (`pending`, `requires_capture`, `quote`, `canceled`…, un riferimento Stripe digitato) | `payment_pending` | sì |

**Basi di rilascio, sempre distinte** (nell'audit, nei log, nelle schermate): pagamento verificato (`stripe_verified`, `paypal_verified`, `free_order`), pagamento **ricevuto e attestato** da un amministratore (`manual_payment`), **credito commerciale** (`commercial_credit`, S6a: nessun incasso, il dovuto resta visibile) e autorizzazione eccezionale dell'amministratore (`admin_authorization`).

**`paymentStatus = paid` da solo non è una prova.** La prova è ciò che scrive il server dopo aver controllato il denaro: un riferimento Stripe (`stripePaymentIntentId` o `stripeInvoiceId`) **insieme a** `paidAt`, a un tentativo `paid` o al record Stripe nei metadati; oppure una cattura PayPal verificata; oppure `metadata.manualPayment` completo (`by`, `at`, `reason`, `method` e, da S6a, **`receivedVia`** — `cash` o `bank_transfer` —, **`amountCents`** che copre il totale e **`currency`** uguale a quella dell'ordine); oppure il totale a zero. Un riferimento Stripe digitato da una persona, un evento PrintLab o una parola di stato **non rilasciano nulla**.

**Un'autorizzazione non prevale mai** su un pagamento tenuto, in conferma o ancora aperto, **né su un rimborso in corso (S6a)**. Per questi casi si risolve prima il pagamento (`payment-hold`) o si chiude il rimborso; un'autorizzazione è la decisione di una persona di produrre **senza** un pagamento verificato, non una scorciatoia sopra un denaro che potrebbe arrivare o che sta uscendo.

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

**Privacy (cancellazione dell'account).** `lib/privacy.ts` **non è stato modificato** (cambierebbe il sistema privacy): azzera **tutti** i metadati dell'ordine (`metadata = NULL`) e lascia `shippingAddress`; così si perdono l'autorizzazione, i claim e il registro. La difesa lato produzione non richiede di toccare la privacy: un ordine con metadati azzerati ha **esiti sconosciuti** (`metadata_lost`) ⇒ nessun invio né consumo senza riconciliazione col sistema esterno, nessun nuovo tentativo per dichiarazione. **Proposta separata (da approvare):** far conservare alla cancellazione i soli marcatori operativi. **S6a non cambia questa decisione** (v. §15.8, AP-PRIV).

## 11. Viste e interfaccia amministratore

- **Coda** (`getProductionSnapshot`): contiene **solo ordini rilasciati**; posizione, tempo stimato e `queueHours` non contano gli altri. Gli ordini trattenuti compaiono in `notReleased` **solo** con `includeRelease: true` (pagine e API admin): stato, testo, motivo di revisione, «PrintLab reported», cosa è già andato in produzione, esiti incerti. Un ordine pagato e rilasciato ma ancora `awaiting_*` è «waiting for an administrator».
- **Tempo di consegna mostrato ai clienti** (`lead-time-estimator`): **si accorcia**, perché non conta più i checkout abbandonati (nessun effetto sul prezzo).
- **Pianificatori**: quelli che guardano **avanti** (`batch-optimization`, previsioni StockWorks) compongono `releasedOrderWhere()` con il loro filtro; quelli che guardano **indietro** (storia flotta, rapporto sprechi) non contano come stampato un ordine ancora `awaiting_*`.
- **Nessuna fuga ai clienti**: `release`, `notReleased`, `paymentReviewReason`, il registro delle chiamate e l'autorizzazione non compaiono in nessuna risposta cliente (API ordine, dettaglio produzione, snapshot senza `includeRelease`); provato per ogni stato.
- **Pagina ordine admin**: riquadro «Production release» (stato, base, chi/quando/perché dell'autorizzazione, pagamento manuale, codice di revisione, «PrintLab reported», registro delle chiamate con il modulo «Confirm with the PrintLab/StockWorks record», ciò che è già andato in produzione); `OrderStatusControl` (stato attuale, nota di rilascio, pulsante «Move to queue», richiesta di autorizzazione **in pagina** con motivo di almeno 10 caratteri — solo per `PAYMENT_NOT_VERIFIED`/`PAYMENT_UNPROVEN`/`EXTERNAL_ORDER_NOT_AUTHORIZED` e solo per l'amministratore; per blocchi, conferme in corso e pagine aperte nessun modulo, solo il messaggio); `PrinterAssignmentPanel`, `PrintLabSubmitButton`, `PrintLabLinkPanel` si disattivano e spiegano perché. **Il server resta l'autorità**: i pulsanti disattivati sono una spiegazione, non una protezione. `OrderStatusBadge` dice «Awaiting payment»/«Awaiting review» invece di «Queued».
- Layout: un'unica interfaccia responsive; bersagli ≥ 44 px, nessuno scorrimento orizzontale, nessun testo troncato (prove su `chromium` 1280×720, `mobile` 393×851, `mobile-small` 360×640: **emulazione**, non telefoni veri).

## 12. Limiti noti e cose non coperte (nessuna presentata come risolta)

1. **Ordini non ospitati con un motivo di revisione** (carta legacy spenta in produzione, oppure collegati con `stripe-attach`): `payment-hold` rifiuta gli ordini senza tentativi (`NOT_A_HOSTED_ORDER`) e nessun altro percorso azzera il motivo ⇒ l'ordine **resta bloccato**. È la direzione sicura ma è un vicolo cieco operativo: la procedura eccezionale è un progetto separato da sottoporre (vincolo V1).
2. **Contestazione (`dispute`) su un ordine già segnalato**: `payment-sync` non la registra (richiede la colonna vuota); correzione proposta per S6 (parte Stripe di P3). **Ancora aperto dopo S6a**: P3 nella parte che legge contestazioni e transazioni di saldo è trattenuta fino a SP1.
3. ~~**Tentativo `processing` rimasto su un ordine pagato**~~ — **chiuso in S6a (F13)**: `decidePaymentUpdate` chiude come `failed` un altro tentativo che Stripe dice annullato o fallito su un ordine già pagato (§15.5).
4. ~~**Rimborso totale**: non blocca; `payment-sync` può copiare `refundedCents` da un addebito duplicato~~ — **chiuso in S6a per la decisione di produzione (F04, F05, F26)**: un rimborso del pagamento dell'ordine toglie il rilascio (`payment_refunded`), un rimborso in corso lo blocca (`payment_refund_pending`), e un pagamento duplicato non sovrascrive più i dati dell'ordine (§15.2, §15.5). **Resta aperto**: un rimborso fatto *dal Dashboard di Stripe* si vede solo quando una sincronizzazione lo legge (R-S6-2, Passo 5), e il rimborso *dall'app* non è ancora governato (P5, §15.10).
5. **Nessuna notifica** all'amministratore quando un blocco compare su un ordine già in lavorazione; `recoverPostPaymentEffects` non ha chiamanti in produzione (Passo 5); l'effetto post-pagamento `inventory` (scorte dei prodotti pronti) **non** è condizionato al rilascio (è una prenotazione di magazzino per un pagamento reale e non verrebbe mai ripetuto).
6. **Statistiche non operative** (`admin/analytics`, `demand-forecasting`, `creator-quality`, `lib/admin/queries`) contano ancora ordini non pagati.
7. **Sincronizzazione OrderWorks `pending → queued`**: una questione di direzione, non di rilascio; invariata.
8. **Controllo di origine non esteso** alle altre rotte admin (§7).
9. `scripts/hold-unpaid-orders.js` mantiene la vecchia nozione (più larga: «pagato o gratuito = verificato», qualunque autorizzazione `authorized` vale, senza revisione, senza rimborsi) e si limita a retrocedere da `queued` a `awaiting_payment`, senza blocco di riga né audit (F16, **non toccato in S6a**: va allineato o ritirato; se lo si esegue, solo in una finestra senza pagamenti in corso e dopo `--dry-run`); `payment-hold`: la scorciatoia `acknowledgeUnverified` (F01) è stata tolta da P4-0 (§15.11); il resto di P4 (verifica per motivo: F02, F03, F12) **resta aperto e bloccante per il lancio**; `lib/reprint.ts` usa ancora `isProductionEligible`.
10. **Consumo parziale in StockWorks**: se un errore interrompe i movimenti di un ordine, il consumo può restare parziale; il registro lo rende visibile (una voce per riga) e la riga incerta non viene ripetuta; la deduplica per riga con riferimenti per riga cambierebbe i riferimenti scritti in StockWorks e non è provabile qui.
11. **Privacy**: vedi §10 (non modificata, segnalata).
12. Un **pagamento PayPal verificato dal server** è stato aggiunto come quarta base di prova (differenza dal piano).
13. **Limiti e rischi aperti dopo S6a**: v. §15.10 (F01, R1, rimborso dall'app non governato, contestazioni, notifiche, privacy, `unresolved`).

## 13. Cosa è simulato e cosa va verificato con servizi reali

Simulato: Stripe (a livello di SDK/HTTP finto), PrintLab e StockWorks (server HTTP locali che contano le richieste, registrano lavori/movimenti e possono rifiutare, perdere la risposta, andare in timeout), database di prova locale, browser Chromium con emulazione di telefono.

**Da verificare con servizi reali** (righe aperte in `docs/CHECKLIST-PRELANCIO.md`): che PrintLab **onori le chiavi di idempotenza** e che il suo elenco lavori/`GET /api/jobs/<id>` si comporti come assunto dalla riconciliazione; che i movimenti StockWorks siano leggibili per riferimento; Stripe reale in modalità test (collegamento di un PaymentIntent con `metadata.orderId`, dispute reali, **i diciotto fatti T1–T18 di S6a**, v. §15.7); un iPhone con Safari e un Android veri sulle nuove schermate; un operatore reale che usi il riquadro «Production release», l'autorizzazione in pagina, il modulo di conferma e, da S6a, il modulo di incasso attestato e quello del credito commerciale.

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

**Prove di S6a** (stessi comandi di sopra; i file nuovi si possono lanciare da soli, uno per volta sul database di prova):

```
node --test --import tsx tests/financial-revision.test.ts tests/s6-release-policy.test.ts tests/s6-hygiene.test.ts tests/production-release-facts-oracle.test.ts tests/production-release-guards.test.ts tests/stripe-test-mode-verify.test.ts
SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest node --test --test-concurrency=1 --import tsx \
  tests/security/s6-money-gaps.sec.ts tests/security/s6-attested-receipts.sec.ts tests/security/s6-refund-block.sec.ts \
  tests/security/s6-revision-events.sec.ts tests/security/s6-schema.sec.ts tests/security/s6-legacy-rows.sec.ts
```

File di S6a: `lib/financial-revision.ts` (registro E1–E14 / N1–N10 e `withFinancialRevision`), `tests/_source-scan.ts` (lettore del sorgente usato dalle guardie G11/G12), `tests/security/_s6-flow.ts` (flusso di pagamento simulato), `scripts/stripe-test-mode-verify.ts` + `docs/STRIPE-TEST-MODE-S6.md` (verifica in Test Mode, **mai eseguita**).

## 15. S6a — rimborsi, revisione finanziaria, incassi attestati e credito commerciale

**Che cosa è e che cosa non è.** S6a è la parte di S6 che non dipende dai fatti di Stripe ancora da verificare (§15.7). Contiene: P2 (i rimborsi entrano nella decisione di produzione), P2c (blocco durante un rimborso), P2b (revisione finanziaria che invalida le autorizzazioni), P3 nelle sole parti che non leggono Stripe (F05, F13), P6 (motivo obbligatorio, incassi attestati, credito commerciale, igiene dei dati di pagamento) e lo script di verifica in Test Mode, **preparato e provato solo offline**. **Non contiene**: P1 (posizione dei fondi), la parte di P3 che legge contestazioni e transazioni di saldo, **P4** (`payment-hold` verificato per motivo; la sola rimozione di `acknowledgeUnverified` è stata fatta dopo, da P4-0: §15.11), **P5** (rimborso governato come operazione: protocollo, riconciliazione, adozione, fascicolo, `StripePaymentPanel`), l'interfaccia di S6b, alcuna modifica a `lib/privacy.ts` (AP-PRIV) né alcuna procedura di sblocco di un rimborso non risolto (AP-ESC). Nessuna chiamata a Stripe, nemmeno in modalità test, è stata eseguita da questo repository.

### 15.1 Che cosa cambia nella regola

- **`payment_refunded` / `PAYMENT_REFUNDED`** (F04). Se il pagamento Stripe dell'ordine è stato rimborsato in tutto o in parte (`refundedCents > 0`), la base `stripe_verified` **decade**: il denaro, o una parte, è tornato indietro. L'ordine non è rilasciato; **un amministratore può autorizzarlo con un motivo scritto** (come un ordine non pagato). Rimborsi di un pagamento *duplicato* non toccano l'ordine (F05, §15.5).
- **`payment_refund_pending` / `REFUND_IN_PROGRESS`** (F26). Un rimborso chiesto dall'app e non ancora concluso **blocca la produzione senza possibilità di autorizzazione** (§15.2).
- **Autorizzazione con revisione** (F25): un'autorizzazione vale solo finché l'ordine ha la revisione finanziaria che aveva alla concessione (§15.3). Una senza revisione (anteriore a S6) o con revisione diversa non rilascia nulla: la decisione espone `authorizationStale` = `no_revision` | `revision_changed` e l'ordine torna **autorizzabile con un nuovo motivo**.
- **Base `commercial_credit`** (§15.4): produzione a credito per `invoice`/`po`, **senza incasso**, con il dovuto sempre visibile.
- **Motivo obbligatorio per ogni autorizzazione** (F08): `REASON_REQUIRED` (400) quando manca o ha meno di 10 caratteri (prima valeva solo per le ristampe; il codice vecchio `AUTHORIZATION_REASON_REQUIRED` non esiste più). Vale anche per un ordine a totale zero.

### 15.2 Rimborso in corso: la produzione si ferma (P2c)

Un'operazione di rimborso (`RefundOperation`, migrazione M3a, §16) è la riga che dice «l'app ha chiesto a Stripe di restituire denaro». Una **sola definizione** — `refundOperationBlocks` in `lib/order-payment-policy.ts`, con la forma Prisma `refundOperationBlocksWhere` — dice quali operazioni bloccano la produzione:

| Stato dell'operazione | Blocca? |
|---|---|
| `requested`, `sending`, `unknown`, `pending`, `requires_action`, `unresolved` | **sì, sempre** (anche a lease scaduto) |
| `succeeded`, `failed`, `canceled` | **sì finché `appliedAt` è vuoto** (lo stato assoluto di Stripe non è ancora stato riletto e applicato) |
| `succeeded`, `failed`, `canceled` con `appliedAt` | no |
| `abandoned` (prova che nulla è mai stato inviato: `firstSentAt` vuoto, imposto anche dal vincolo CHECK del database) | no |
| qualunque stato sconosciuto | **sì** (fallire chiusi) |

Dove si applica — sempre la stessa definizione, nessuna seconda porta: `releaseDecision` (regola 2b, prima di «in conferma» e di ogni prova o autorizzazione); `releasedOrderWhere` (il prefiltro è **esatto** su questo punto); la lettura sotto il blocco di riga di `withReleaseLock` (`lib/production-release.ts`: ogni effetto — stato, assegnazione, coda, invio a PrintLab, collegamento, callback, sincronizzazione OrderWorks, consumo di materiale — rivaluta sui fatti riletti); `lib/production.ts` (l'ordine esce dalla coda e dalle ore di lavoro, compare in «Not in production» con «Not released - refund in progress»); `lib/stockworks-consumption.ts` (il rifiuto avviene **prima** di chiedere qualunque cosa a StockWorks); l'approvazione di un'organizzazione (l'ordine attende il pagamento come uno in blocco).

Altre decisioni rifiutate mentre l'operazione è aperta: `payment-hold` (`accepted`/`no_charge` ⇒ `409 REFUND_IN_PROGRESS`, **prima** di interrogare Stripe e di nuovo sotto il blocco; l'evento di rifiuto in audit arriva con P4), una nuova autorizzazione o un credito commerciale (non autorizzabile), e la modifica o la cancellazione dell'ordine (motivo `refund_operation` di `ORDER_HAS_PAYMENT_EVIDENCE`: **è questo il codice che si riceve per righe e totale**, non `REFUND_IN_PROGRESS`; una riga di rimborso non lascia più cancellare l'ordine con un errore 500 della sola chiave esterna).

Che cosa **non** fa: non richiama né ferma ciò che è già stato inviato a PrintLab o a una stampante (§6: `blockedAfterSend`, nessun comando); non usa `paymentReviewReason` (l'unico scrittore di `paymentReviewReason: null` resta `lib/payment-hold.ts`).

**Che cosa NON esiste ancora.** Nessun codice dell'applicazione **scrive** oggi una `RefundOperation`: il blocco è provato con righe scritte dai test (`tests/security/s6-refund-block.sec.ts`, la matrice di `production-release.sec.ts` con un ingresso per ogni stato, la parità del prefiltro). Il protocollo che le crea — reclamo scritto **prima** di qualunque chiamata a Stripe, i cinque esiti di `refunds.create` (un HTTP 200 non è un rimborso completato), riconciliazione, `unresolved`, adozione di un rimborso verificato, fascicolo — è il pacchetto **P5, non eseguito**. La rotta `POST /api/admin/orders/<id>/refund` è **invariata** (F07 aperto: consentita anche allo staff, senza motivo né audit, risponde `ok:true` per ogni rimborso creato, chiave di idempotenza che cambia dopo il primo rimborso). Finché P5 non c'è, un rimborso fatto dalla rotta o dal Dashboard si vede solo quando una sincronizzazione legge `refundedCents` (R-S6-2).

### 15.3 Revisione finanziaria: un'autorizzazione non può tornare in vita (P2b)

`PrintOrder.financialRevision` (migrazione M3b, §16) è un contatore che **solo sale**. Ogni scrittore che cambia un fatto finanziario lo incrementa **nella stessa `UPDATE`** e sotto il blocco di riga che già tiene, tramite `withFinancialRevision(prev, data, extras)` (`lib/financial-revision.ts`); nessun codice assegna il valore, solo `{ increment: 1 }`. L'autorizzazione registra la revisione che l'ordine aveva alla concessione e vale solo se coincide: se i valori cambiano e poi **tornano uguali** (rimborso richiesto e poi fallito, contestazione aperta e poi risolta, totale cambiato e ripristinato) il confronto di valori non se ne accorgerebbe, il contatore sì. Una nuova autorizzazione, con motivo, sostituisce il record.

L'elenco è **chiuso e numerato** nel codice. Incrementano la revisione:

| | Evento |
|---|---|
| E1 | cambia lo stato di pagamento o la data di pagamento (in qualunque direzione) |
| E2 | il motivo di revisione del pagamento viene impostato, cambiato o tolto |
| E3 | cambia l'importo rimborsato |
| E4 | cambia un totale, un subtotale, la spedizione, l'imposta, lo sconto o la valuta |
| E5 | cambia il PaymentIntent o la fattura Stripe collegati |
| E6 | cambia il metodo di pagamento (decide il tipo di autorizzazione ammesso) |
| E7 | cambia una prova Stripe nei metadati (stato del pagamento, PaymentIntent, fattura, contestazione) |
| E8 | cambia la prova PayPal nei metadati |
| E9 | si registra o si varia un incasso attestato |
| E10 / E11 | nuova voce nel registro di revisione del pagamento / nelle risoluzioni di blocco |
| E12 | un tentativo di pagamento entra o esce da `processing`/`paid`/`mismatch`, o cambia l'importo ricevuto o il suo PaymentIntent |
| E13 | cambia stato un'operazione di rimborso (**nessuno scrittore esiste ancora**: arriva con P5, e una guardia ne tiene l'elenco vuoto) |
| E14 | l'ordine viene annullato o riaperto |

**Non** la incrementano (con la ragione scritta nel codice): ricevute e campi di fattura, contabilità del lease di sincronizzazione, la sola disponibilità di una pagina di pagamento (aperta, scaduta o fallita **senza denaro**: una pagina aperta blocca già da sola, e un cliente non deve poter annullare una decisione dell'amministratore aprendone una), gli stati di produzione e le stampanti, i marcatori dei flussi di produzione, ristampe/approvazioni/prezzi amministrativi, l'accesso ospite, indirizzo e note, le righe che non cambiano gli importi, e la concessione dell'autorizzazione stessa. Il passare del tempo non è un evento.

Come è tenuto onesto: **G11** (guardia sul sorgente: ogni scrittura di una colonna finanziaria, di una chiave finanziaria dei metadati o di un tentativo usa `withFinancialRevision` o sta in un elenco di esenzioni con la ragione); **G1-create** (registro dei creatori di ordini) e **G12** (la parola «pagato» solo dove un pagamento è verificato o attestato); l'**oracolo** (`tests/production-release-facts-oracle.test.ts`: la decisione gira su un `Proxy` che registra ogni dato letto, e un dato non classificato fa fallire il test — se domani la decisione legge un fatto nuovo, qualcuno deve classificarlo); un test per ogni evento e per ogni scrittore, anche in coppia «cambia e ritorna»; una **sonda nel database** (trigger solo di prova) che dimostra «la revisione sale se e solo se un fatto cambia, nella stessa `UPDATE`». La revisione è una **colonna**, non un dato dei metadati: una riscrittura dei metadati con una copia vecchia dell'autorizzazione, un valore forgiato da un mittente esterno (`financialRevision` è una chiave riservata), un valore di tipo errato o la cancellazione dei dati del cliente non la fanno scendere e non riattivano nulla.

Il prefiltro `releasedOrderWhere` non può confrontare una colonna con un valore dentro un JSON: per le autorizzazioni resta un **sovrainsieme**; il confronto esatto lo fa sempre `releaseDecision` sotto il blocco (nessun effetto usa il prefiltro come unica porta; le letture di pianificazione che lo usano da solo possono includere un ordine con autorizzazione non più valida, e nessun effetto ne dipende).

### 15.4 Incassi attestati e credito commerciale (P6)

Cose diverse, mai fuse (**un credito non è un incasso**):

| Cosa | `paymentStatus` | Base di rilascio |
|---|---|---|
| Incasso verificato (Stripe; PayPal catturato e verificato dal server) | `paid` | `stripe_verified` / `paypal_verified` |
| Incasso **ricevuto e attestato** da un amministratore (contanti; bonifico **con riferimento**) | `paid` | `manual_payment` |
| Fattura da incassare / ordine d'acquisto (`invoice`, `po`) | **resta `pending`** | nessuna da sola; con autorizzazione **commerciale** → `commercial_credit` |
| Autorizzazione **eccezionale** (senza pagamento) | `pending` | `admin_authorization` |
| Nessun addebito (`comped`) / totale zero | `free` | `free_order` |

- **`invoice` e `po` non diventano mai `paid`** da una parola: `PATCH /api/jobs/<id>` risponde `409 INVOICE_OR_PO_IS_CREDIT` se non si dice **come è stato ricevuto il denaro** (`receivedVia`: `cash` o `bank_transfer`). Un bonifico richiede il riferimento dell'estratto conto (`400 RECEIPT_REFERENCE_REQUIRED`). **PayPal non è attestabile** (`409 PAYPAL_NOT_ATTESTABLE`: è pagato quando il server ha verificato la cattura). Una vendita in contanti si riceve in contanti (`RECEIPT_METHOD_MISMATCH`). `card` resta «solo Stripe».
- **Importo e valuta li mette il server** (il totale dell'ordine, sotto il blocco): mai digitati. Un incasso che non copre più il totale (totale modificato dopo la registrazione) non è più una prova: `payment_unproven` finché non si registra di nuovo.
- **`recordAttestedReceipt`** (`lib/orders.ts`) è l'unico scrittore di un incasso su un ordine **già creato** (prima non esisteva e l'incasso veniva scartato in silenzio): sotto `withReleaseLock`, nella stessa transazione dell'audit `admin.order.receipt.attest`, scrive insieme `paymentStatus` e `manualPayment` (eventi E1 ed E9). Rifiuta un ordine con prove Stripe, blocco, rimborso o tentativi (`ORDER_HAS_PAYMENT_EVIDENCE`) e un incasso **già registrato** (`409 RECEIPT_ALREADY_REGISTERED`: non si modifica né si cancella da qui; la correzione di un errore è una procedura separata, fuori da S6).
- **Credito commerciale**: per un ordine `invoice`/`po` l'unica autorizzazione ammessa prima dell'incasso è quella `commercial_credit` (`409 CREDIT_KIND_MISMATCH` nei due versi sbagliati), solo `admin`, con motivo, riferimento della fattura o dell'ordine (`400 CREDIT_REFERENCE_REQUIRED`) e scadenza facoltativa; l'importo dovuto lo mette il server. La decisione e le schermate dicono sempre «Released - commercial credit (…): … still due». Quando il denaro arriva la base diventa `stripe_verified` o `manual_payment` e il dovuto sparisce; se il totale cambia o arriva un rimborso, il credito si sospende (E4, E3).
- **Registrazioni anteriori a S6** (metodo `invoice`/`po`/`paypal`, o senza `receivedVia` o senza importo) **non valgono** come prova (fail-closed): l'ordine è «pagato senza prova» (`payment_unproven`, autorizzabile) finché l'incasso non viene registrato come sopra (`tests/security/s6-legacy-rows.sec.ts`).
- Adeguamenti minimi dell'interfaccia admin, senza schermi né stili nuovi (bersagli ≥ 44 px, nessuno scorrimento orizzontale): `OrderStatusControl` (motivo per ogni autorizzazione; per un ordine `invoice`/`po` riferimento e scadenza, e una nota che dice che non è un pagamento; `PAYMENT_REFUNDED` tra i rifiuti ai quali si risponde con un'autorizzazione, `REFUND_IN_PROGRESS` no), `UserOrderCreator` (motivo; riferimento e scadenza per `invoice`/`po`), `JobQueue` (come è stato ricevuto il denaro e il riferimento quando si marca pagato un job `invoice`/`po`; mostra il rifiuto), `ProductionReleasePanel` e `NotReleasedList` (testi e colori per `payment_refunded`, `payment_refund_pending`, credito con dovuto, autorizzazione non più valida, incasso attestato). Emulato in Chromium e nei due formati mobili; **non** provato su telefoni veri.

### 15.5 Pagamenti doppi e tentativi su ordini già pagati (P3, parti senza Stripe)

- **F05**: `payment-sync` registra i dati dell'addebito (`stripeChargeId`, ricevuta, cliente, **`refundedCents`**, metadati Stripe) **solo per il PaymentIntent dell'ordine**; un pagamento *duplicato* (pagina gemella) resta tracciato sul tentativo e l'ordine non viene più contaminato (prima, dopo aver rimborsato il duplicato, l'ordine mostrava «rimborsato 100%»).
- **F13**: su un ordine già pagato, un altro tentativo che Stripe dice annullato o fallito passa a `failed` (prima restava `processing` e bloccava per sempre un ordine pagato).
- `closeAttempt` accetta solo `failed`/`expired` e il ritorno a una pagina già completata presso il fornitore passa da `markPageCompleteAtProvider` (una transazione, che incrementa la revisione: E12).

### 15.6 Igiene dei dati di pagamento (P6)

- **F15/F20**: il ripiego `'paid'` del checkout vecchio è diventato `'pending'`; la guardia G1 copre anche i creatori di ordini e G12 vieta di assumere «pagato» fuori dall'elenco chiuso di scrittori.
- **F21**: il `paymentIntentId` scelto dal browser è **ignorato** per i metodi diversi da carta/PayPal (nessuna colonna Stripe, nessuna lettura di Stripe, id fatto dal server); i valori scritti dal server (`paymentIntentId`, `source`, `jobFormId`, `orderId`) prevalgono sullo spread dei metadati di un mittente esterno, e quelle chiavi sono riservate.
- **F22**: `updateOrderMetadata` accetta solo le sei colonne di ricevuta e fattura (tipo ristretto + guardia): non si può più scrivere `status`/`paymentStatus`/`paidAt` da lì.
- **F23**: un ordine il cui pagamento **non** è verificato riceve un documento «Order Confirmation - Payment Pending», non «Payment Receipt» né «Cash Pickup Receipt»; «Amount after refunds» solo per ordini pagati.
- **F24**: la notifica all'amministratore dice «Payment received» solo per un pagamento verificato (per `quote`: richiesta di preventivo; per il resto: ordine ricevuto, pagamento in attesa).

### 15.7 Fatti di Stripe: lo script di verifica (nessuna chiamata eseguita)

Le regole che dipendono da come Stripe si comporta davvero (rimborsi `pending`/`failed`, visibilità ritardata, idempotenza, contestazioni e transazioni di saldo, `Charge.disputed` dopo la chiusura…) sono i **diciotto fatti T1–T18**. In S6a **nessuno è verificato**: lo script `scripts/stripe-test-mode-verify.ts` e la guida `docs/STRIPE-TEST-MODE-S6.md` sono stati scritti e provati **solo offline**, con un Stripe finto; **nessuna chiamata a Stripe, nemmeno in Test Mode, è stata fatta**. Lo script lo esegue il titolare, con una chiave ristretta di test immessa senza eco, in un account di test dedicato, con massimi dichiarati (`--dry-run` li mostra: importi ≤ 1,00 per pagamento e ≤ 5,00 in totale, massimo di oggetti e di chiamate) e un rapporto sanificato che è l'unica cosa da inviare. Ciò che il Test Mode non conferma resta `not_confirmable`: il percorso di codice che ne dipende resta nella forma conservativa e la riga 1.44 della checklist **resta Bloccante**. Fino al via libera su SP1 non si scrivono P1, la parte Stripe di P3, P4 e P5.

### 15.8 Privacy (AP-PRIV): invariata

`lib/privacy.ts` **non è stato modificato**. La cancellazione dei dati di un cliente azzera tutti i metadati dei suoi ordini: spariscono `manualPayment`, `paypal`, `productionAuthorization`, `paymentReview`, `paymentHoldResolution`, `stripe`; non vengono azzerati l'indirizzo di spedizione, le ricevute PDF e gli URL di fattura. Con S6a: un ordine rilasciato per incasso attestato, PayPal, credito o autorizzazione diventa **non rilasciato** (`payment_unproven`, fail-closed — nessuna scorciatoia nuova e nessuna prova cancellata in più); un ordine rilasciato per un pagamento Stripe verificato **resta rilasciato**, perché la prova sta nelle colonne; la colonna `financialRevision` non contiene dati personali e non viene toccata. **Limite dichiarato (R-S6-10): prima di cancellare un cliente, verifica i suoi ordini aperti** (in particolare quelli in produzione, a credito o pagati fuori da Stripe). L'inventario dei dati personali nei metadati finanziari, la proposta di minimizzazione e la conferma sui tempi di conservazione contabile e fiscale (da un professionista) sono la proposta separata **AP-PRIV**: nulla in S6a la anticipa.

### 15.9 Rimborsi non risolti: nessuno sblocco per assenza (AP-ESC)

Quando P5 esisterà, un'operazione che potrebbe essere stata inviata e non è riconciliabile diventerà `unresolved` e **resterà bloccante** (produzione e nuove operazioni). L'assenza in `refunds.list`, un `amount_refunded` invariato e la conferma di un amministratore **non** sono una prova di mancata esecuzione e non devono mai poter generare un secondo rimborso: l'unica uscita applicativa prevista è l'**adozione** di un rimborso verificato che porta la nostra `metadata.makerworksOperationId`. Se non compare, l'ordine resta bloccato e segue un'**escalation operativa separata, fuori dall'app** (fascicolo di sola lettura, contatto con il supporto di Stripe, chi decide): **non esiste alcun codice di sblocco** e non ne viene scritto in S6; se servirà, sarà un progetto a parte da sottoporre al titolare (AP-ESC). In S6a esiste solo il blocco (§15.2).

### 15.10 Limiti e rischi aperti dopo S6a (nessuno presentato come risolto)

1. **F01 — chiusa da P4-0 (§15.11):** `acknowledgeUnverified` non esiste più; con Stripe non verificabile «nessun addebito» è rifiutato (`409 STRIPE_UNVERIFIABLE`). **Non sono chiusi** F02 (un tentativo senza identificativi vale ancora «nessun denaro»), F03 (`accepted` verifica ancora solo il database) e F12: restano aperti e bloccanti per il lancio (resto di P4).
2. **R1 (ospiti: il doppio acquisto non è prevenuto, solo reso più gestibile) non è accettato ed è bloccante per il lancio.** S6a non lo cambia.
3. **Il rimborso dall'app non è governato** (P5, F07): staff ammesso, nessun motivo né audit, chiave di idempotenza che dipende dall'importo, `ok:true` anche per un rimborso `pending`; un duplicato non si rimborsa dall'app. Il blocco di produzione c'è, ma nessun codice crea ancora le operazioni che lo attivano.
4. **Contestazioni e fondi** (F06, F03, F12, P1/P3-Stripe/P4): invariati. `accepted` verifica ancora solo il database; una contestazione non ha ancora un ciclo di vita completo.
5. **Rimborsi e contestazioni fatti dal Dashboard** si vedono solo quando una sincronizzazione li legge; nessuna riconciliazione periodica né notifica (Passo 5, R-S6-2).
6. **`payment-hold` non scrive ancora un evento di rifiuto in audit** quando respinge una decisione (`REFUND_IN_PROGRESS`, `STRIPE_UNVERIFIABLE`) (la tassonomia decisione / verifica / rifiuto arriva con P4).
7. **Righe e totale di un ordine con un rimborso** ricevono `ORDER_HAS_PAYMENT_EVIDENCE` con il motivo `refund_operation`, non `REFUND_IN_PROGRESS`.
8. **`scripts/hold-unpaid-orders.js`** usa ancora la vecchia nozione (F16): va allineato o ritirato; non è stato toccato.
9. **Privacy** (R-S6-10) e **ordini `unresolved`** (AP-ESC): v. §15.8 e §15.9.
10. **Ordini anteriori a S6**: le autorizzazioni senza revisione e gli incassi registrati senza `receivedVia`/importo (o con `invoice`/`po`/`paypal`) non valgono più; oggi non esistono ordini reali. L'esito dell'esame di un database migrato dal vecchio schema è in `docs/VERIFICA-4.6.md` (il nuovo codice può solo **restringere**: nessun ordine che la regola vecchia teneva fermo viene ora rilasciato).
11. **Casi che richiedono il protocollo di P5** (reclamo con 0 chiamate a Stripe, due processi sul reclamo, rimborso di un duplicato su un ordine in blocco, riavvio in tre punti: M85, M88, M89, M112) **non sono provati**.
12. **Nessuna prova su dispositivi reali** (iPhone con Safari, Android), Stripe reale, PayPal, PrintLab, StockWorks o stampanti reali.

### 15.11 P4-0: la scorciatoia `acknowledgeUnverified` è tolta (F01)

Dopo il checkpoint SP1, con un'autorizzazione limitata, è stato eseguito **solo** il pacchetto P4-0 (cifre e prove: `docs/VERIFICA-4.6.md`, «S6a.16»).

- **Che cosa è cambiato.** `acknowledgeUnverified` non è più un campo della richiesta né dell'input di `resolvePaymentHold`; l'esito `unreachable_acknowledged` e il codice `STRIPE_UNREACHABLE` non esistono più. La rotta `payment-hold` ha un corpo `.strict()`: una richiesta che contiene il campo riceve **400** prima che Stripe sia interrogato. Se Stripe non è raggiungibile, oppure la sincronizzazione o la lettura di una pagina di pagamento non riescono, «nessun addebito» è rifiutato con **409 `STRIPE_UNVERIFIABLE`**: non esiste alcun modo di decidere comunque.
- **Che cosa è garantito.** L'impossibilità di verificare Stripe non autorizza mai una risoluzione `no_charge`. Quando tutte le letture di Stripe falliscono, l'ordine, i suoi tentativi e le pagine di pagamento restano come erano e nessuna decisione viene registrata in audit. **Precisione:** la sincronizzazione che precede la decisione è indipendente: tiene solo i propri registri di lavoro (lease e orario dell'ultima lettura: N2) e, se trova un pagamento **reale**, lo registra (e allora «nessun addebito» è rifiutato come `PAYMENT_COLLECTED`). L'assenza di modifiche al database non è quindi garantita in assoluto, ma lo è nello scenario in cui Stripe non risponde.
- **Che cosa NON è cambiato e NON è chiuso.** `accepted` verifica ancora solo il database (F03); un tentativo senza identificativi Stripe vale ancora «nessun denaro» (F02); il vicolo cieco di un pagamento rimborsato (F12); il rifiuto non scrive ancora un evento in audit (arriva con P4); contestazioni e posizione dei fondi (P1, P3-Stripe), R1 e il rimborso dall'app (P5) sono invariati.
- **Perché non torni.** Guardia statica G13 (`tests/production-release-guards.test.ts`): nessuno dei tre nomi in `app/`, `lib/`, `components/`, nemmeno in un commento; il test di regressione `tests/security/payment-hold.sec.ts` conserva la descrizione del difetto.

## 16. Migrazioni S6: ripristino senza distruggere dati

S6a aggiunge **due migrazioni additive**, mai applicate a un database reale:

| | Migrazione | Che cosa fa |
|---|---|---|
| M3a | `20261022120000_refund_operation` | crea la tabella `RefundOperation` con chiave primaria, indice univoco su `stripeRefundId`, indice `(orderId, status)`, chiave esterna verso `PrintOrder` **`ON DELETE RESTRICT`** e il vincolo `CHECK ("status" <> 'abandoned' OR "firstSentAt" IS NULL)` (solo SQL: Prisma non lo conosce) |
| M3b | `20261022130000_print_order_financial_revision` | `ALTER TABLE "PrintOrder" ADD COLUMN "financialRevision" INTEGER NOT NULL DEFAULT 0` |

Nessuna riga esistente viene letta, spostata o modificata; le righe esistenti partono da `financialRevision = 0`. Il codice precedente a S6a ignora la tabella e la colonna.

**Che cosa è stato provato** (su database di prova isolati del cluster locale, nomi che finiscono in `_sectest`; mai su un database reale): impronta (conteggio e somma di controllo di ogni tabella) di un database nello schema di S5 con dati; **backup con `pg_dump` e ripristino su una copia con impronta identica**; `prisma migrate status` sulla copia (le due migrazioni risultano in attesa), `prisma migrate deploy`, impronta di nuovo identica (tutte le tabelle; `PrintOrder` senza la colonna nuova), 28 ordini con `financialRevision = 0`, 0 righe in `RefundOperation`; nessuna deriva (`prisma migrate diff` della copia contro lo schema e delle migrazioni contro lo schema su un database ombra: nessuna differenza); i vincoli SQL (il CHECK rifiuta `abandoned` con `firstSentAt` in inserimento e in aggiornamento ma accetta `abandoned` senza; la chiave esterna rifiuta un ordine inesistente e la cancellazione di un ordine con operazioni; `stripeRefundId` univoco, ma più `NULL` convivono; `financialRevision` è `NOT NULL` con valore predefinito 0); la catena completa da zero su un database vuoto (96 migrazioni, seconda esecuzione idempotente); `tests/security/s6-schema.sec.ts`; e il **codice precedente** (HEAD `b464d04`) eseguito contro lo schema migrato.

### Prima di toccare un database reale

1. **Backup verificato**, non solo fatto: copia completa del database (`pg_dump -Fc`), somma di controllo del file, **ripristino su un database di prova** e confronto di conteggi e somme di controllo per tabella, `prisma migrate status` e controllo di deriva. Solo dopo, `prisma migrate deploy` sul database reale, in una finestra senza pagamenti in corso.
2. Dopo la migrazione: `prisma migrate status` (nessuna migrazione in attesa), `SELECT count(*) FROM "RefundOperation"` (0) e `SELECT DISTINCT "financialRevision" FROM "PrintOrder"` (solo 0).

### Tornare indietro senza distruggere dati finanziari

`DROP TABLE "RefundOperation"` **non è un rollback** appena esiste una sola operazione: cancella la storia dei rimborsi chiesti, i loro esiti e l'idempotenza. `DROP COLUMN "financialRevision"` cancella il contatore da cui dipende la validità di ogni autorizzazione (il codice precedente tornerebbe a considerare valide autorizzazioni invalidate). **Nessuno dei due fa parte della procedura ordinaria**; sono ammessi solo su una struttura mai usata (database vuoto o copia di prova).

- **Rollback applicativo**: si rimette in servizio la versione precedente dell'applicazione e si **lasciano al loro posto** la tabella e la colonna (inerti per quel codice). **Prima**, si chiudono o si adottano le operazioni di rimborso aperte, perché il codice precedente non le vede e **non bloccherebbe più la produzione**. Interrogazione di guardia (deve restituire **0 righe** prima di tornare indietro):

  ```sql
  SELECT "id", "orderId", "status", "appliedAt", "firstSentAt"
  FROM "RefundOperation"
  WHERE "status" <> 'abandoned'
    AND NOT ("status" IN ('succeeded','failed','canceled') AND "appliedAt" IS NOT NULL);
  ```

  È la stessa definizione di `refundOperationBlocks` (provata su una copia: su una riga per ogni stato, con e senza `appliedAt`, e uno stato sconosciuto, restituisce esattamente le operazioni che bloccano). **Non si riattiva mai una versione che ignori operazioni di rimborso aperte o `unresolved`.** Con la versione precedente in servizio, le autorizzazioni date con S6a restano valide per quel codice anche se la revisione è cambiata: dopo un rollback applicativo, va riesaminato a mano ogni ordine rilasciato per autorizzazione.
- **Correzione in avanti**: un problema si corregge con una nuova migrazione additiva, non con un `DROP`.
- **Archiviazione al posto della cancellazione**: se una struttura va davvero tolta dopo l'uso, `ALTER TABLE … RENAME TO …` più un export con somma di controllo verificata; i dati si conservano finché i requisiti di conservazione contabile e fiscale non sono confermati da un professionista (v. AP-PRIV). Un eventuale `DROP` definitivo è una decisione a parte, con approvazione esplicita.
